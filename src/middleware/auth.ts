// apps/backend-simple/src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express'
import {
  type ProjectImageSettings,
  normalizeProjectImageSettings,
  setProjectAuthContext,
  setStaticFileIndexingAllowed,
} from '../project-settings'
import { clientIp } from '../client-ip'
import { FailureLimiter } from '../failure-limiter'
import { envNumber } from '../env'
import { VALIDATION_API_URL, withValidationTimeout } from '../validation-service'

interface CacheEntry {
  settings: ProjectImageSettings
  expiresAt: number
  /** While the validation service is down the stale entry answers, and the service is not asked before this time. */
  retryAt: number
}

type Verdict =
  | { kind: 'valid'; settings: ProjectImageSettings }
  /** The key, or this origin for the key, is not accepted. */
  | { kind: 'refused' }
  /** 403: this server's secret does not belong to the key's project. */
  | { kind: 'misconfigured' }
  /** 429, 5xx, a network error or a timeout: no answer about the key. */
  | { kind: 'unavailable' }

// Longer values are never asked about and never stored: header-sized strings must not become Map keys.
const MAX_API_KEY_LENGTH = 256
const MAX_ORIGIN_LENGTH = 2048
// A revoked key or a removed domain stops working within this time.
const CACHE_TTL_MS = 15 * 60 * 1000
// How long past its expiry an entry still marks the pair as known (see `onlineAuth`).
const STALE_MS = 60 * 60 * 1000
const RETRY_MS = 60 * 1000
// A refused key is not asked about again for this long: a flood of bad requests must not turn into
// a flood of calls to the validation service, which would then rate-limit this server for everyone.
const DENIED_TTL_MS = 60 * 1000
const MAX_CACHE = 10_000
const MAX_DENIED = 10_000
// The validation service limits this whole server, by its address, to about 1200 calls a minute.
// The pairs the server does not know share one window of VALIDATION_GLOBAL_LIMIT calls.
const GLOBAL_WINDOW_MS = 60 * 1000
// A fixed window lets twice the limit out around its boundary: 300 keeps that at half of the 1200.
const GLOBAL_LIMIT = 300
// After the validation service failed, how long no unknown pair is sent to it.
const BACKOFF_MS = 15 * 1000

const cache = new Map<string, CacheEntry>()
const denied = new Map<string, { until: number; kind: 'refused' | 'misconfigured' }>()
const inFlight = new Map<string, Promise<Verdict>>()
const failures = new FailureLimiter()
// Counts the validations an address starts, whatever their outcome.
const attempts = new FailureLimiter(undefined, () => ({
  limit: envNumber('VALIDATION_ATTEMPT_LIMIT', 60),
  windowMs: 60_000,
  blockMs: 60_000,
  maxEntries: 50_000,
}))
// The validations of unknown pairs that all addresses together started in the current window.
const globalWindow = { start: 0, count: 0 }
let backoffUntil = 0

/** Exposed for test teardown only — do not use in production code */
export function clearAuthCache(): void {
  cache.clear()
  denied.clear()
  inFlight.clear()
  failures.clear()
  attempts.clear()
  globalWindow.start = 0
  globalWindow.count = 0
  backoffUntil = 0
}

/**
 * The validation service matches an Origin by hostname only, so every scheme and port of a site
 * is one cache entry. Keyed by the raw Origin, `https://site.example:1001`, `:1002`, … would each
 * be a new, valid entry and a new outbound call.
 *
 * Anything else is refused by the service. The leading ':' (which cannot begin a hostname) keeps
 * such a string apart from the hostnames: `site.example` sent as a bare Origin must neither be
 * served from the entry of `https://site.example` nor get that entry removed by being refused.
 */
function originKey(origin: string): string {
  try {
    const url = new URL(origin)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.hostname.toLowerCase()
  } catch {
    // Not a URL.
  }
  return `:${origin}`
}

// What the cache keys of every origin of one API key begin with: a header value cannot hold \x00.
const keyPrefixOf = (apiKey: string): string => `${apiKey}\x00`
const cacheKeyOf = (apiKey: string, origin: string): string => `${keyPrefixOf(apiKey)}${originKey(origin)}`

/**
 * Stores settings that were refreshed or changed for every origin the key is held with: they are
 * the project's, and the other origins would otherwise serve the old ones until their entries expire.
 */
export function updateCachedProjectImageSettings(apiKey: string, settings: ProjectImageSettings): void {
  const ofKey = keyPrefixOf(apiKey)
  let held = false
  for (const [cacheKey, entry] of cache) {
    if (!cacheKey.startsWith(ofKey)) continue
    entry.settings = settings
    held = true
  }
  if (held) setStaticFileIndexingAllowed(settings.allowFileIndexing)
}

export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void | Promise<void> {
  if (req.path === '/health') {
    next()
    return
  }

  return onlineAuth(req, res, next)
}

function refuse(req: Request, res: Response, error: string): void {
  failures.recordFailure(clientIp(req))
  res.status(401).json({ error })
}

function unavailable(res: Response, retryAfterSec?: number): void {
  if (retryAfterSec) res.setHeader('Retry-After', String(retryAfterSec))
  res.status(503).json({ error: 'Validation service unavailable' })
}

/**
 * 403 from the validation service. Counted like a refused key: an address could otherwise spend
 * its whole budget of attempts on such keys, minute after minute, and never be blocked.
 */
function misconfigured(req: Request, res: Response): void {
  failures.recordFailure(clientIp(req))
  unavailable(res)
}

const secondsUntil = (time: number, now: number): number => Math.ceil((time - now) / 1000)

/** Seconds of the back-off that are left; all of it when none is running. */
const backoffLeft = (now: number): number => (backoffUntil > now ? secondsUntil(backoffUntil, now) : BACKOFF_MS / 1000)

/** Seconds until the window of all addresses has room for another validation; 0 when it has now. */
function globalWindowFullFor(now: number): number {
  if (now - globalWindow.start >= GLOBAL_WINDOW_MS) {
    globalWindow.start = now
    globalWindow.count = 0
  }
  if (globalWindow.count < envNumber('VALIDATION_GLOBAL_LIMIT', GLOBAL_LIMIT)) return 0
  return secondsUntil(globalWindow.start + GLOBAL_WINDOW_MS, now)
}

function tooMany(res: Response, retryAfterSec: number, error: string): void {
  res.setHeader('Retry-After', String(retryAfterSec))
  res.status(429).json({ error, reason: 'rate_limited' })
}

/** Never throws: whatever goes wrong on the way is "unavailable". */
async function askCentral(apiKey: string, origin: string, validationSecret: string): Promise<Verdict> {
  try {
    return await withValidationTimeout(async (signal): Promise<Verdict> => {
      const response = await fetch(`${VALIDATION_API_URL}/validation/verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-validation-secret': validationSecret,
        },
        body: JSON.stringify({ apiKey, origin }),
        signal,
      })

      if (response.status === 403) return { kind: 'misconfigured' }
      if (response.status === 429 || response.status >= 500) return { kind: 'unavailable' }
      if (response.status !== 200) return { kind: 'refused' }

      const data = await response.json() as {
        valid: boolean
        plan?: string
        settings?: Partial<ProjectImageSettings>
      }
      if (!data.valid) return { kind: 'refused' }

      return { kind: 'valid', settings: normalizeProjectImageSettings({ ...data.settings, plan: data.plan }) }
    })
  } catch {
    return { kind: 'unavailable' }
  }
}

/** Applies a verdict to the caches. Once per outbound call, however many requests wait for it. */
function remember(cacheKey: string, verdict: Verdict): void {
  const now = Date.now()
  switch (verdict.kind) {
    case 'valid':
      // Deleted first so that a revalidated key becomes the newest. Oldest out: a key that is valid
      // for many hostnames cannot grow memory without bound.
      cache.delete(cacheKey)
      cache.set(cacheKey, { settings: verdict.settings, expiresAt: now + CACHE_TTL_MS, retryAt: 0 })
      while (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string)
      return
    case 'refused':
    case 'misconfigured':
      // A definite answer. The entry goes too: a revoked key must not be served stale, and a pair
      // that stayed "known" would skip the denied cache and ask the service on every request.
      cache.delete(cacheKey)
      denied.delete(cacheKey)
      denied.set(cacheKey, { until: now + DENIED_TTL_MS, kind: verdict.kind })
      while (denied.size > MAX_DENIED) denied.delete(denied.keys().next().value as string)
      return
    case 'unavailable': {
      // Nothing is learned about the key. A known pair is served stale and waits before asking again.
      const entry = cache.get(cacheKey)
      if (entry) entry.retryAt = now + RETRY_MS
      // Nor is any unknown pair sent for a while, whichever pair found the service failing.
      backoffUntil = now + BACKOFF_MS
    }
  }
}

/**
 * One outbound call per cache key at a time: a burst of requests with one key (a page that loads
 * twenty thumbnails, or a flood) waits for a single answer.
 */
function validate(cacheKey: string, apiKey: string, origin: string, validationSecret: string): Promise<Verdict> {
  let pending = inFlight.get(cacheKey)
  if (!pending) {
    pending = askCentral(apiKey, origin, validationSecret)
      .then((verdict) => {
        remember(cacheKey, verdict)
        return verdict
      })
      .finally(() => inFlight.delete(cacheKey))
    inFlight.set(cacheKey, pending)
  }
  return pending
}

async function onlineAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rawApiKey = req.headers['x-api-key']
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey
  if (!apiKey) return refuse(req, res, 'API key required')

  const origin = (req.headers['origin'] as string) || ''
  if (apiKey.length > MAX_API_KEY_LENGTH || origin.length > MAX_ORIGIN_LENGTH) {
    return refuse(req, res, 'Invalid API key')
  }

  const validationSecret = process.env.VALIDATION_SECRET
  if (!validationSecret) {
    console.warn('[auth] VALIDATION_SECRET is not set; rejecting all requests')
    return unavailable(res)
  }

  const cacheKey = cacheKeyOf(apiKey, origin)
  const now = Date.now()
  const serve = (settings: ProjectImageSettings): void => {
    setProjectAuthContext(req, { apiKey, origin, settings })
    next()
  }

  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > now) return serve(cached.settings)

  // A known pair: it was valid recently, so somebody's live session is behind it. It may always
  // revalidate — an address shared by many users (or misdetected behind a proxy) that got blocked
  // or ran out of attempts must not lock those sessions out when their entry expires. This costs
  // the validation service nothing extra: one call per key per TTL, as for any valid key.
  const stale = cached && now - cached.expiresAt < STALE_MS ? cached : undefined
  // Served as it is while its own last call failed less than a minute ago, or anybody's just did.
  if (stale && (stale.retryAt > now || backoffUntil > now)) return serve(stale.settings)

  if (!stale) {
    const ip = clientIp(req)
    const blockedFor = failures.blockedFor(ip)
    if (blockedFor > 0) return tooMany(res, blockedFor, 'Too many failed requests')

    const remembered = denied.get(cacheKey)
    if (remembered) {
      if (remembered.until > now) {
        return remembered.kind === 'refused' ? refuse(req, res, 'Invalid API key') : misconfigured(req, res)
      }
      denied.delete(cacheKey)
    }

    // Reserved before the call, not counted after it: a burst of concurrent requests with distinct
    // keys would otherwise all pass the check before the first failure is recorded. Joining a call
    // that is already in flight is free.
    if (!inFlight.has(cacheKey)) {
      const retryAfter = attempts.blockedFor(ip)
      if (retryAfter > 0) return tooMany(res, retryAfter, 'Too many requests')

      // An outage: every new key would otherwise cost one more call that fails or hangs for 5 seconds.
      if (backoffUntil > now) return unavailable(res, backoffLeft(now))
      // Many addresses, each within its own budget: 20 of them would get this whole server limited.
      const fullFor = globalWindowFullFor(now)
      if (fullFor > 0) return unavailable(res, fullFor)

      // Reserved last: a request that was held back sent nothing, and costs its address nothing.
      attempts.recordFailure(ip)
      globalWindow.count += 1
    }
  }

  const verdict = await validate(cacheKey, apiKey, origin, validationSecret)
  switch (verdict.kind) {
    case 'valid':
      return serve(verdict.settings)
    case 'refused':
      return refuse(req, res, 'Invalid API key')
    case 'misconfigured':
      return misconfigured(req, res)
    case 'unavailable':
      // Stale on error: whoever can make the validation service rate-limit this server must not be
      // able to end every session as its entry expires.
      // The failed call has just started the back-off: that is when asking again can help.
      return stale ? serve(stale.settings) : unavailable(res, backoffLeft(Date.now()))
  }
}
