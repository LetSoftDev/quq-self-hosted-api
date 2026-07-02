import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { TrashStore } from '../storage/trash'
import { authMiddleware } from '../middleware/auth'
import { getStorage, resetStorage } from './files'

export { resetStorage }  // re-export so tests can reset both at once

const router = Router()

let trashStore: TrashStore | null = null

export const getTrashStore = (): TrashStore => {
  if (!trashStore) {
    const dataDir = process.env.DATA_DIR || './data'
    trashStore = new TrashStore(path.join(dataDir, 'trash.db'))
  }
  return trashStore
}

export const resetTrashStore = () => {
  trashStore = null
}

router.use(authMiddleware)

router.get('/trash', async (req, res) => {
  try {
    const limitRaw = req.query.limit !== undefined ? parseInt(req.query.limit as string, 10) : 50
    const limit = Math.min(isNaN(limitRaw) ? 50 : limitRaw, 200)
    const offsetRaw = req.query.offset !== undefined ? parseInt(req.query.offset as string, 10) : 0
    const offset = isNaN(offsetRaw) ? 0 : offsetRaw
    const query = typeof req.query.query === 'string' ? req.query.query.toLowerCase().trim() : ''
    const { items, total: dbTotal } = getTrashStore().list(200, 0)

    const filtered = query ? items.filter(item => item.name.toLowerCase().includes(query)) : items
    const total = filtered.length
    const pageItems = filtered.slice(offset, offset + limit)

    const files = await Promise.all(pageItems.map(async item => {
      let preview: string | undefined
      if (item.type === 'file') {
        try {
          const previewPath = getStorage().getPreviewPath(item.original_path)
          await fs.access(previewPath)
          preview = `/api/preview?path=${encodeURIComponent(item.original_path)}`
        } catch { /* no preview */ }
      }
      return {
        trashId: item.id,
        name: item.name,
        path: item.original_path,
        type: item.type,
        url: '/files' + item.original_path,
        modified: item.deleted_at,
        ...(preview ? { preview } : {}),
      }
    }))
    res.json({ files, total, hasMore: offset + files.length < total })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/trash/move', async (req, res) => {
  try {
    const { paths } = req.body as { paths: string[] }
    if (!Array.isArray(paths)) return res.status(400).json({ error: 'paths must be an array' })

    const uploadsDir = path.resolve(process.env.UPLOADS_DIR || './uploads')
    const trashDir = path.join(uploadsDir, '.trash')
    let moved = 0

    for (const p of paths) {
      try {
        const absPath = getStorage().resolvePublic(p)
        const stats = await fs.stat(absPath)
        const type: 'file' | 'dir' = stats.isDirectory() ? 'dir' : 'file'
        const id = crypto.randomUUID()
        const itemTrashDir = path.join(trashDir, id)
        await fs.mkdir(itemTrashDir, { recursive: true })
        await fs.rename(absPath, path.join(itemTrashDir, path.basename(absPath)))
        const normalizedPath = p.startsWith('/') ? p : '/' + p
        getTrashStore().add(id, normalizedPath, path.basename(p), type)
        moved++
      } catch {
        // skip individual failures
      }
    }

    res.json({ moved })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/trash/restore', async (req, res) => {
  try {
    const { id } = req.body as { id: string }
    const item = getTrashStore().getById(id)
    if (!item) return res.status(404).json({ error: 'Item not found in trash' })

    const uploadsDir = path.resolve(process.env.UPLOADS_DIR || './uploads')
    const trashDir = path.join(uploadsDir, '.trash')
    const originalDest = getStorage().resolvePublic(item.original_path)
    const finalName = await getStorage().resolveConflictName(path.dirname(originalDest), item.name)
    const finalDest = path.join(path.dirname(originalDest), finalName)

    await fs.mkdir(path.dirname(finalDest), { recursive: true })
    await fs.rename(path.join(trashDir, id, item.name), finalDest)
    await fs.rm(path.join(trashDir, id), { recursive: true })
    getTrashStore().remove(id)

    // Compute restored virtual path
    const restoredVirtualPath = '/' + path.relative(path.resolve(process.env.UPLOADS_DIR || './uploads'), finalDest).replace(/\\/g, '/')
    res.json({ path: restoredVirtualPath })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/trash/delete', async (req, res) => {
  try {
    const { id } = req.body as { id: string }
    const item = getTrashStore().getById(id)
    if (!item) return res.status(404).json({ error: 'Item not found in trash' })

    const uploadsDir = path.resolve(process.env.UPLOADS_DIR || './uploads')
    const trashDir = path.join(uploadsDir, '.trash')

    await fs.rm(path.join(trashDir, id), { recursive: true })

    if (item.type === 'file') {
      try {
        const previewPath = getStorage().getPreviewPath(item.original_path)
        await fs.rm(previewPath, { force: true })
      } catch {
        // ENOENT or traversal error — silently ignore
      }
    }

    getTrashStore().remove(id)
    res.json({ deleted: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

export { router as trashRouter }
