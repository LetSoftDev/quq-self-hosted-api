import { Router } from 'express'
import { authMiddleware, updateCachedProjectImageSettings } from '../middleware/auth'
import {
  type ProjectImageSettings,
  getProjectAuthContext,
  normalizeProjectImageSettings,
} from '../project-settings'
import { envNumber } from '../env'
import { rateLimit } from '../rate-limit'
import { VALIDATION_API_URL, withValidationTimeout } from '../validation-service'

const router = Router()

// Reading is answered from what the server holds, and that is refreshed this often per key: a
// client that polls the settings must not turn every request into a call to the validation service.
const REFRESH_MS = 60 * 1000
const MAX_REFRESHED = 10_000
const refreshedAt = new Map<string, number>()
// Every change is a call to the validation service. Per address, per minute.
const settingsLimit = rateLimit('RATE_LIMIT_SETTINGS', 30)
// The limit per address multiplies by the number of addresses: the changes that all addresses
// together send to the validation service share one window of SETTINGS_UPDATE_GLOBAL_LIMIT (60).
const UPDATE_WINDOW_MS = 60 * 1000
const updateWindow = { start: 0, count: 0 }
// Sent with a 503 for a call that failed: the time auth.ts itself waits after a failed call.
const RETRY_AFTER_SEC = 15

router.use(authMiddleware)

/** Exposed for test teardown only — do not use in production code */
export function clearSettingsRefreshes(): void {
  refreshedAt.clear()
  updateWindow.start = 0
  updateWindow.count = 0
}

/** Seconds until the window of all addresses has room for another change; 0 when it has now. */
function updateWindowFullFor(now: number): number {
  if (now - updateWindow.start >= UPDATE_WINDOW_MS) {
    updateWindow.start = now
    updateWindow.count = 0
  }
  if (updateWindow.count < envNumber('SETTINGS_UPDATE_GLOBAL_LIMIT', 60)) return 0
  return Math.ceil((updateWindow.start + UPDATE_WINDOW_MS - now) / 1000)
}

/**
 * Whether the key's settings are due for a refresh, which the caller then starts. Marked before
 * the call and whatever its outcome: requests that arrive together make one call, and so does a
 * minute of an outage.
 */
function refreshDue(apiKey: string): boolean {
  const now = Date.now()
  const last = refreshedAt.get(apiKey)
  if (last !== undefined && now - last < REFRESH_MS) return false
  refreshedAt.delete(apiKey)
  refreshedAt.set(apiKey, now)
  // Oldest first: the keys of many projects cannot grow memory without bound.
  while (refreshedAt.size > MAX_REFRESHED) refreshedAt.delete(refreshedAt.keys().next().value as string)
  return true
}

function getValidationSecret(): string | undefined {
  return process.env.VALIDATION_SECRET
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * The validation service answers about the settings without the project's plan: the plan the key
 * is held with is kept, or a refresh would turn a pro project into a free one. What depends on the
 * plan is then derived from it.
 */
function withHeldPlan(answer: Partial<ProjectImageSettings>, held: ProjectImageSettings): ProjectImageSettings {
  return normalizeProjectImageSettings({ ...answer, plan: answer.plan ?? held.plan })
}

async function fetchProjectSettings(apiKey: string): Promise<Partial<ProjectImageSettings>> {
  const validationSecret = getValidationSecret()
  if (!validationSecret) throw new Error('Validation service unavailable')

  return withValidationTimeout(async (signal) => {
    const response = await fetch(
      `${VALIDATION_API_URL}/validation/project-settings?apiKey=${encodeURIComponent(apiKey)}`,
      {
        headers: { 'x-validation-secret': validationSecret },
        signal,
      },
    )

    if (!response.ok) throw new Error('Failed to fetch project settings')
    return await response.json() as Partial<ProjectImageSettings>
  })
}

async function patchProjectSettings(
  apiKey: string,
  patch: Partial<ProjectImageSettings>,
): Promise<Partial<ProjectImageSettings>> {
  const validationSecret = getValidationSecret()
  if (!validationSecret) throw new Error('Validation service unavailable')

  return withValidationTimeout(async (signal) => {
    const response = await fetch(`${VALIDATION_API_URL}/validation/project-settings`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-validation-secret': validationSecret,
      },
      body: JSON.stringify({ apiKey, ...patch }),
      signal,
    })

    if (!response.ok) throw new Error('Failed to update project settings')
    return await response.json() as Partial<ProjectImageSettings>
  })
}

router.get('/settings', async (req, res) => {
  const context = getProjectAuthContext(req)
  if (!context) {
    res.status(401).json({ error: 'Invalid API key' })
    return
  }

  // What the key was validated with, or what the last refresh or change stored for it.
  if (!refreshDue(context.apiKey)) {
    res.json(context.settings)
    return
  }

  try {
    const settings = withHeldPlan(await fetchProjectSettings(context.apiKey), context.settings)
    updateCachedProjectImageSettings(context.apiKey, settings)
    res.json(settings)
  } catch {
    res.json(context.settings)
  }
})

router.patch('/settings', settingsLimit, async (req, res) => {
  const context = getProjectAuthContext(req)
  if (!context) {
    res.status(401).json({ error: 'Invalid API key' })
    return
  }

  const patch: Partial<ProjectImageSettings> = {}
  const createImagePreviews = readBoolean(req.body?.createImagePreviews)
  const optimizeImages = readBoolean(req.body?.optimizeImages)
  const allowFileIndexing = readBoolean(req.body?.allowFileIndexing)

  if (createImagePreviews !== undefined) patch.createImagePreviews = createImagePreviews
  if (optimizeImages !== undefined) patch.optimizeImages = optimizeImages
  if (allowFileIndexing !== undefined) patch.allowFileIndexing = allowFileIndexing

  // Nothing to change: the validation service would only be asked to answer what the server holds.
  if (Object.keys(patch).length === 0) {
    res.json(context.settings)
    return
  }

  const fullFor = updateWindowFullFor(Date.now())
  if (fullFor > 0) {
    res.setHeader('Retry-After', String(fullFor))
    res.status(503).json({ error: 'Failed to update project settings' })
    return
  }
  // Counted before the call, not after it: requests that arrive together would otherwise all pass.
  updateWindow.count += 1

  try {
    const settings = withHeldPlan(await patchProjectSettings(context.apiKey, patch), context.settings)
    updateCachedProjectImageSettings(context.apiKey, settings)
    res.json(settings)
  } catch {
    // Not the error's own message: fetch's is about this server's network, not about the request.
    res.setHeader('Retry-After', String(RETRY_AFTER_SEC))
    res.status(503).json({ error: 'Failed to update project settings' })
  }
})

export const settingsRouter = router
