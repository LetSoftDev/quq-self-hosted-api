import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { StarStore } from '../storage/stars'
import { authMiddleware } from '../middleware/auth'
import { sendError } from '../http-errors'
import { getStorage } from '../storage/instance'

const router = Router()

let starStore: StarStore | null = null

export const getStarStore = (): StarStore => {
  if (!starStore) {
    const dataDir = process.env.DATA_DIR || './data'
    starStore = new StarStore(path.join(dataDir, 'stars.db'))
  }
  return starStore
}

export const resetStarStore = () => {
  starStore = null
}

router.use(authMiddleware)

router.get('/stars', async (req, res) => {
  try {
    const limitRaw = req.query.limit !== undefined ? parseInt(req.query.limit as string, 10) : 200
    const limit = Math.min(isNaN(limitRaw) ? 200 : limitRaw, 200)
    const offsetRaw = req.query.offset !== undefined ? parseInt(req.query.offset as string, 10) : 0
    const offset = isNaN(offsetRaw) ? 0 : offsetRaw
    const query = typeof req.query.query === 'string' ? req.query.query.toLowerCase().trim() : ''

    const { items: allItems } = getStarStore().list(200, 0)
    const filtered = query ? allItems.filter(item => item.name.toLowerCase().includes(query)) : allItems
    const total = filtered.length
    const items = filtered.slice(offset, offset + limit)
    const files = await Promise.all(items.map(async item => {
      let preview: string | undefined
      try {
        // Validated: a stored path must not be able to probe files outside the previews folder.
        await fs.access(getStorage().getPreviewPath(item.path))
        preview = `/api/preview?path=${encodeURIComponent(item.path)}`
      } catch { /* no preview exists */ }
      return {
        name: item.name,
        path: item.path,
        type: item.type,
        url: '/files' + item.path,
        modified: item.starred_at,
        starred: true,
        ...(preview ? { preview } : {}),
      }
    }))

    res.json({
      files,
      total,
      hasMore: offset + files.length < total,
    })
  } catch (error: any) {
    sendError(res, error)
  }
})

router.post('/stars/toggle', (req, res) => {
  try {
    const { path: filePath, name, type } = req.body
    if (!filePath || !name || !type) {
      return res.status(400).json({ error: 'path, name, and type are required' })
    }
    if (type !== 'file' && type !== 'dir') {
      return res.status(400).json({ error: 'type must be "file" or "dir"' })
    }
    // JSON can deliver an object, an array or a number: SQLite cannot bind the first two.
    if (typeof filePath !== 'string' || typeof name !== 'string') {
      return res.status(400).json({ error: 'Invalid request' })
    }
    try {
      getStorage().resolvePublic(filePath)
    } catch {
      return res.status(400).json({ error: 'Invalid path' })
    }
    const starred = getStarStore().toggle(filePath, name, type)
    res.json({ starred })
  } catch (error: any) {
    sendError(res, error)
  }
})

export { router as starsRouter }
