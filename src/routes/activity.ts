import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { ActivityStore } from '../storage/activity'
import { authMiddleware } from '../middleware/auth'
import type { ActivitySummary, QuqFile } from '../types'
import { getStorage } from './files'

const router = Router()

let activityStore: ActivityStore | null = null
const getActivityStore = () => {
  if (!activityStore) {
    const dataDir = process.env.DATA_DIR || './data'
    activityStore = new ActivityStore(path.join(dataDir, 'activity.db'))
  }
  return activityStore
}

export const resetActivityStore = () => {
  activityStore = null
}

router.use(authMiddleware)

const fileExists = async (file: QuqFile): Promise<boolean> => {
  try {
    await fs.access(getStorage().resolvePublic(file.path))
    return true
  } catch {
    return false
  }
}

const filterExistingFiles = async (files: QuqFile[]): Promise<QuqFile[]> => {
  const checks = await Promise.all(
    files.map(async file => ({
      file,
      exists: await fileExists(file)
    }))
  )

  return checks.filter(({ exists }) => exists).map(({ file }) => file)
}

const filterExistingSummary = async (summary: ActivitySummary): Promise<ActivitySummary> => ({
  quickAccess: await filterExistingFiles(summary.quickAccess),
  recentFiles: await filterExistingFiles(summary.recentFiles)
})

router.post('/activity', (req, res) => {
  try {
    const { path: filePath, name, type } = req.body
    if (!filePath || !name || !type) {
      return res.status(400).json({ error: 'path, name, and type are required' })
    }
    if (type !== 'file' && type !== 'dir') {
      return res.status(400).json({ error: 'type must be "file" or "dir"' })
    }
    getActivityStore().record(filePath, name, type)
    res.status(204).end()
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.get('/activity/summary', async (req, res) => {
  try {
    const summary = getActivityStore().getSummary()
    res.json(await filterExistingSummary(summary))
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

export { router as activityRouter }
