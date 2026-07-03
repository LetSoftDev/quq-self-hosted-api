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

const getMimeType = (filename: string): string | undefined => {
  const ext = path.extname(filename).toLowerCase()
  const mimeMap: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
  }
  return mimeMap[ext]
}

const enrichExistingFile = async (file: QuqFile): Promise<QuqFile | null> => {
  try {
    await fs.access(getStorage().resolvePublic(file.path))
  } catch {
    return null
  }

  const enriched: QuqFile = {
    ...file,
    mime: file.type === 'file' ? getMimeType(file.name) : file.mime,
  }

  if (file.type === 'file') {
    try {
      await fs.access(getStorage().getPreviewPath(file.path))
      enriched.preview = `/api/preview?path=${encodeURIComponent(file.path)}`
    } catch {
      // No preview exists — keep the activity item without a thumbnail.
    }
  }

  return enriched
}

const filterExistingFiles = async (files: QuqFile[]): Promise<QuqFile[]> => {
  const enriched = await Promise.all(files.map(enrichExistingFile))
  return enriched.filter((file): file is QuqFile => file !== null)
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
