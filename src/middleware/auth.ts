// apps/backend-simple/src/middleware/auth.ts
import { Request, Response, NextFunction } from 'express'

interface CacheEntry {
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

/** Exposed for test teardown only — do not use in production code */
export function clearAuthCache(): void {
  cache.clear()
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

  const backendProUrl = process.env.BACKEND_PRO_URL
  if (!backendProUrl) {
    console.warn('[auth] BACKEND_PRO_URL is not set; rejecting all requests')
    res.status(503).json({ error: 'Validation service unavailable' })
    return
  }

  return onlineAuth(req, res, next, backendProUrl)
}

async function onlineAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  backendProUrl: string,
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
    next()
    return
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const fetchResponse = await fetch(`${backendProUrl}/validation/verify`, {
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

    const data = await fetchResponse.json() as { valid: boolean }
    if (!data.valid) {
      res.status(401).json({ error: 'Invalid API key' })
      return
    }

    cache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS })
    next()
  } catch {
    res.status(503).json({ error: 'Validation service unavailable' })
  } finally {
    clearTimeout(timeoutId)
  }
}
