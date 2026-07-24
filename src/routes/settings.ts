import { Router } from 'express'
import { authMiddleware, updateCachedProjectImageSettings } from '../middleware/auth'
import {
  type ProjectImageSettings,
  getProjectAuthContext,
  getProjectImageSettings,
  normalizeProjectImageSettings,
} from '../project-settings'

const router = Router()
const VALIDATION_API_URL = 'https://qapi.letsoft.co'

router.use(authMiddleware)

function getValidationSecret(): string | undefined {
  return process.env.VALIDATION_SECRET
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

async function fetchProjectSettings(apiKey: string): Promise<ProjectImageSettings> {
  const validationSecret = getValidationSecret()
  if (!validationSecret) throw new Error('Validation service unavailable')

  const response = await fetch(
    `${VALIDATION_API_URL}/validation/project-settings?apiKey=${encodeURIComponent(apiKey)}`,
    {
      headers: { 'x-validation-secret': validationSecret },
    },
  )

  if (!response.ok) throw new Error('Failed to fetch project settings')
  return normalizeProjectImageSettings(await response.json() as Partial<ProjectImageSettings>)
}

async function patchProjectSettings(
  apiKey: string,
  patch: Partial<ProjectImageSettings>,
): Promise<ProjectImageSettings> {
  const validationSecret = getValidationSecret()
  if (!validationSecret) throw new Error('Validation service unavailable')

  const response = await fetch(`${VALIDATION_API_URL}/validation/project-settings`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'x-validation-secret': validationSecret,
    },
    body: JSON.stringify({ apiKey, ...patch }),
  })

  if (!response.ok) throw new Error('Failed to update project settings')
  return normalizeProjectImageSettings(await response.json() as Partial<ProjectImageSettings>)
}

router.get('/settings', async (req, res) => {
  const context = getProjectAuthContext(req)
  if (!context) {
    res.status(401).json({ error: 'Invalid API key' })
    return
  }

  try {
    const settings = await fetchProjectSettings(context.apiKey)
    updateCachedProjectImageSettings(context.apiKey, context.origin, settings)
    res.json(settings)
  } catch {
    res.json(getProjectImageSettings(req))
  }
})

router.patch('/settings', async (req, res) => {
  const context = getProjectAuthContext(req)
  if (!context) {
    res.status(401).json({ error: 'Invalid API key' })
    return
  }

  const patch: Partial<ProjectImageSettings> = {}
  const createImagePreviews = readBoolean(req.body?.createImagePreviews)
  const optimizeImages = readBoolean(req.body?.optimizeImages)

  if (createImagePreviews !== undefined) patch.createImagePreviews = createImagePreviews
  if (optimizeImages !== undefined) patch.optimizeImages = optimizeImages

  try {
    const settings = await patchProjectSettings(context.apiKey, patch)
    updateCachedProjectImageSettings(context.apiKey, context.origin, settings)
    res.json(settings)
  } catch (error: any) {
    res.status(503).json({ error: error.message || 'Failed to update project settings' })
  }
})

export const settingsRouter = router
