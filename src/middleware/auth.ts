// apps/backend-simple/src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express'
import {
  type ProjectImageSettings,
  normalizeProjectImageSettings,
  setProjectAuthContext,
} from '../project-settings'

interface CacheEntry {
  expiresAt: number
  apiKey: string
  origin: string
  settings: ProjectImageSettings
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
const VALIDATION_API_URL = 'https://qapi.letsoft.co'

/** Exposed for test teardown only — do not use in production code */
export function clearAuthCache(): void {
  cache.clear()
}

export function updateCachedProjectImageSettings(apiKey: string, origin: string, settings: ProjectImageSettings): void {
  const cacheKey = `${apiKey}\x00${origin}`
  const cached = cache.get(cacheKey)
  if (!cached) return
  cache.set(cacheKey, { ...cached, settings })
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

async function onlineAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const rawApiKey = req.headers['x-api-key']
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey
  if (!apiKey) {
    res.status(401).json({ error: 'API key required' })
    return
  }

  const validationSecret = process.env.VALIDATION_SECRET
  if (!validationSecret) {
    console.warn('[auth] VALIDATION_SECRET is not set; rejecting all requests')
    res.status(503).json({ error: 'Validation service unavailable' })
    return
  }

  const origin = (req.headers['origin'] as string) || ''
  const cacheKey = `${apiKey}\x00${origin}`

  const cached = cache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    setProjectAuthContext(req, {
      apiKey: cached.apiKey,
      origin: cached.origin,
      settings: cached.settings,
    })
    next()
    return
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const fetchResponse = await fetch(`${VALIDATION_API_URL}/validation/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-validation-secret': validationSecret,
      },
      body: JSON.stringify({ apiKey, origin }),
      signal: controller.signal,
    })

    if (fetchResponse.status === 403 || fetchResponse.status === 429 || fetchResponse.status >= 500) {
      res.status(503).json({ error: 'Validation service unavailable' })
      return
    }

    if (fetchResponse.status !== 200) {
      res.status(401).json({ error: 'Invalid API key' })
      return
    }

    const data = await fetchResponse.json() as { valid: boolean; settings?: Partial<ProjectImageSettings> }
    if (!data.valid) {
      res.status(401).json({ error: 'Invalid API key' })
      return
    }

    const settings = normalizeProjectImageSettings(data.settings)
    cache.set(cacheKey, {
      apiKey,
      origin,
      settings,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    setProjectAuthContext(req, { apiKey, origin, settings })
    next()
  } catch {
    res.status(503).json({ error: 'Validation service unavailable' })
  } finally {
    clearTimeout(timeoutId)
  }
}
