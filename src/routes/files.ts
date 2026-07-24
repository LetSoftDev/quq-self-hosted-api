import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs/promises'
import { LocalStorage } from '../storage/local'
import { authMiddleware } from '../middleware/auth'
import { generateThumbnail, THUMBNAIL_MIME_TYPES } from '../storage/thumbnails'
import { OPTIMIZABLE_IMAGE_MIME_TYPES, optimizeImageForBrowser } from '../storage/image-optimization'
import { getProjectImageSettings } from '../project-settings'
import { getStarStore } from './stars'

const router = Router()

let storage: LocalStorage | null = null
export const getStorage = () => {
  if (!storage) {
    storage = new LocalStorage(process.env.UPLOADS_DIR || './uploads')
  }
  return storage
}

const upload = multer({
  dest: 'temp/',
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '5368709120')
  }
})

// Preview thumbnails are public — <img> tags cannot send auth headers
router.get('/preview', (req, res) => {
  const filePath = req.query.path as string
  if (!filePath) return res.status(400).json({ error: 'path is required' })

  let previewPath: string
  try {
    previewPath = getStorage().getPreviewPath(filePath)
  } catch (error: any) {
    return res.status(400).json({ error: error.message })
  }

  res.setHeader('Content-Type', 'image/jpeg')
  res.sendFile(previewPath, (err) => {
    if (err && !res.headersSent) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Preview not found' })
      } else {
        res.status(500).json({ error: 'Failed to stream preview' })
      }
    }
  })
})

// Apply auth to all remaining routes
router.use(authMiddleware)

router.get('/list', async (req, res) => {
  try {
    const dirPath = (req.query.path as string) || '/'
    const limit = req.query.limit !== undefined ? parseInt(req.query.limit as string, 10) : undefined
    const offset = req.query.offset !== undefined ? parseInt(req.query.offset as string, 10) : 0
    const result = await getStorage().list(dirPath, limit, offset)

    // Annotate with starred state
    const paths = result.files.map(f => f.path)
    const starredSet = getStarStore().batchIsStarred(paths)
    const files = result.files.map(f =>
      starredSet.has(f.path) ? { ...f, starred: true } : f
    )

    res.json({ ...result, files })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' })
    }
    const targetPath = req.body.path || '/'
    const file = await getStorage().upload(req.file, targetPath)
    const settings = getProjectImageSettings(req)
    const storage = getStorage()
    const uploadedFilePath = path.join(storage.resolvePublic(targetPath), req.file.originalname)

    if (settings.effectiveOptimizeImages && OPTIMIZABLE_IMAGE_MIME_TYPES.has(req.file.mimetype)) {
      try {
        const result = await optimizeImageForBrowser(uploadedFilePath, req.file.mimetype)
        if (result.optimized) {
          const stats = await fs.stat(uploadedFilePath)
          file.size = stats.size
          file.modified = stats.mtimeMs
        }
      } catch (err: unknown) {
        console.error(`[image-optimization] Failed to optimize ${req.file.originalname}:`, err)
      }
    }

    if (settings.createImagePreviews && THUMBNAIL_MIME_TYPES.has(req.file.mimetype)) {
      const previewDir = storage.getPreviewDir(targetPath)
      const previewPath = path.join(previewDir, req.file.originalname)
      try {
        await generateThumbnail(uploadedFilePath, previewPath)
        file.preview = `/api/preview?path=${encodeURIComponent(file.path)}`
      } catch (err: unknown) {
        console.error(`[thumbnail] Failed to generate preview for ${req.file.originalname}:`, err)
      }
    }

    res.json(file)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/mkdir', async (req, res) => {
  try {
    const { path: dirPath } = req.body
    if (!dirPath) {
      return res.status(400).json({ error: 'Path required' })
    }

    await getStorage().mkdir(dirPath)
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/delete', async (req, res) => {
  try {
    const { paths } = req.body
    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'Paths array required' })
    }

    await getStorage().delete(paths)
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/rename', async (req, res) => {
  try {
    const { oldPath, newPath } = req.body
    if (!oldPath || !newPath) {
      return res.status(400).json({ error: 'oldPath and newPath required' })
    }

    await getStorage().rename(oldPath, newPath)

    // Keep star record in sync
    const newName = path.basename(newPath)
    getStarStore().updatePath(oldPath, newPath, newName)

    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.post('/copy', async (req, res) => {
  try {
    const { sources, destDir } = req.body
    if (!Array.isArray(sources) || sources.length === 0 || typeof destDir !== 'string' || !destDir) {
      return res.status(400).json({ error: 'sources (non-empty array) and destDir (string) required' })
    }
    // Note: if multiple sources are provided and one fails, previously copied sources
    // are not rolled back (consistent with /api/delete behaviour).
    for (const src of sources) {
      await getStorage().copy(src, destDir)
    }
    res.json({ success: true })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

router.get('/search', async (req, res) => {
  try {
    const query = req.query.query as string
    const dirPath = (req.query.path as string) || '/'
    const limitRaw = req.query.limit !== undefined ? parseInt(req.query.limit as string, 10) : 200
    const limit = Math.min(isNaN(limitRaw) ? 200 : limitRaw, 200)

    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'query (non-empty string) required' })
    }

    const result = await getStorage().search(dirPath, query.trim(), limit)
    res.json(result)
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

// For testing: reset storage instance
export const resetStorage = () => {
  storage = null
}

export { router as filesRouter }
