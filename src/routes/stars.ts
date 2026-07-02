import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { StarStore } from '../storage/stars'
import { authMiddleware } from '../middleware/auth'

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
    const uploadsDir = process.env.UPLOADS_DIR || './uploads'
    const previewsRoot = path.join(uploadsDir, '.previews')
    const files = await Promise.all(items.map(async item => {
      const relPath = item.path.startsWith('/') ? item.path.slice(1) : item.path
      let preview: string | undefined
      try {
        await fs.access(path.join(previewsRoot, relPath))
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
    res.status(500).json({ error: error.message })
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
    const starred = getStarStore().toggle(filePath, name, type)
    res.json({ starred })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

export { router as starsRouter }
