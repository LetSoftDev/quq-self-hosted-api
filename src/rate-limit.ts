import type { RequestHandler } from 'express'
import { clientIp } from './client-ip'
import { envNumber } from './env'

const WINDOW_MS = 60_000
const MAX_ENTRIES = 50_000

/**
 * At most `fallback` requests a minute per address (override with the env variable `name`, read on
 * every request). A fixed window in memory: one process serves the API, and a restart forgiving
 * everyone is fine.
 */
export function rateLimit(name: string, fallback: number, now: () => number = Date.now): RequestHandler {
  const windows = new Map<string, { start: number; count: number }>()

  return (req, res, next) => {
    const ip = clientIp(req)
    const time = now()
    let window = windows.get(ip)
    if (!window || time - window.start >= WINDOW_MS) {
      window = { start: time, count: 0 }
      windows.delete(ip)
      windows.set(ip, window)
      // Oldest first: rotating addresses cannot grow memory without bound.
      while (windows.size > MAX_ENTRIES) windows.delete(windows.keys().next().value as string)
    }
    window.count += 1
    if (window.count > envNumber(name, fallback)) {
      res.setHeader('Retry-After', String(Math.ceil((window.start + WINDOW_MS - time) / 1000)))
      res.status(429).json({ error: 'Too many requests', reason: 'rate_limited' })
      return
    }
    next()
  }
}

/**
 * Express `trust proxy`: whose X-Forwarded-For to believe. The default covers the two documented
 * setups, nginx on the same host and Docker's bridge network, and nothing public: a client that
 * reaches Node directly cannot invent its address. TRUST_PROXY=false trusts nothing; a number
 * trusts that many hops; anything else is passed to Express as written.
 */
export function trustProxyFromEnv(): number | boolean | string {
  const raw = (process.env.TRUST_PROXY ?? '').trim()
  if (!raw) return 'loopback, linklocal, uniquelocal'
  if (raw.toLowerCase() === 'false' || raw === '0') return false
  return /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : raw
}
