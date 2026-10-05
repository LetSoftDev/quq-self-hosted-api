import { Router } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs/promises'
import { authMiddleware } from '../middleware/auth'
import { generateThumbnail, THUMBNAIL_MIME_TYPES } from '../storage/thumbnails'
import { OPTIMIZABLE_IMAGE_MIME_TYPES, optimizeImageForBrowser } from '../storage/image-optimization'
import { getProjectImageSettings, getStaticFileIndexingAllowed, ROBOTS_NO_INDEX_HEADER } from '../project-settings'
import { getStarStore } from './stars'
import { getStorage, resetStorage } from '../storage/instance'
import { sendError } from '../http-errors'
import { rateLimit } from '../rate-limit'
export { getStorage, resetStorage }

const router = Router()

const upload = multer({
  dest: 'temp/',
  // Browsers send a file name as UTF-8 bytes; the default, latin1, stores `Отчёт.txt` as mojibake.
  defParamCharset: 'utf8',
  limits: {
    fileSize: parseInt(process.env.MAX_FILE_SIZE || '5368709120')
  }
})

// Per address, per minute. On the routes, so that no spelling of the path can go around them.
const previewLimit = rateLimit('RATE_LIMIT_PREVIEW', 1200)
const uploadLimit = rateLimit('RATE_LIMIT_UPLOAD', 120)
// Search walks the whole tree on every request.
const searchLimit = rateLimit('RATE_LIMIT_SEARCH', 60)

// Preview thumbnails are public — <img> tags cannot send auth headers
router.get('/preview', previewLimit, (req, res, next) => {
  const filePath = req.query.path
  if (!filePath) return res.status(400).json({ error: 'path is required' })

  let previewPath: string
  try {
    // Validated there: `?path[]=a` makes this an array.
    previewPath = getStorage().getPreviewPath(filePath as string)
  } catch (error: any) {
    return sendError(res, error)
  }

  if (!getStaticFileIndexingAllowed()) {
    res.setHeader('X-Robots-Tag', ROBOTS_NO_INDEX_HEADER)
  }
  res.setHeader('Content-Type', 'image/jpeg')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.sendFile(previewPath, (error) => {
    const { code, syscall } = (error ?? {}) as NodeJS.ErrnoException
    // To errorHandler, which answers in JSON. Not when the client went away: nobody is left to answer.
    if (error && code !== 'ECONNABORTED' && syscall !== 'write') next(error)
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
    sendError(res, error)
  }
})

router.post('/upload', uploadLimit, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' })
    }
    // By the file name: the declared part type is only the client's claim.
    const mime = getStorage().mimeTypeOf(req.file.originalname)
    const targetPath = req.body.path || '/'
    const file = await getStorage().upload(req.file, targetPath)
    const settings = getProjectImageSettings(req)
    const storage = getStorage()
    const uploadedFilePath = path.join(storage.resolvePublic(targetPath), req.file.originalname)

    if (settings.effectiveOptimizeImages && OPTIMIZABLE_IMAGE_MIME_TYPES.has(mime)) {
      try {
        const result = await optimizeImageForBrowser(uploadedFilePath, mime)
        if (result.optimized) {
          const stats = await fs.stat(uploadedFilePath)
          file.size = stats.size
          file.modified = stats.mtimeMs
        }
      } catch (err: unknown) {
        console.error(`[image-optimization] Failed to optimize ${req.file.originalname}:`, err)
      }
    }

    // The thumbnail of whatever had this name: /api/preview would go on serving the old picture
    // when the new content gets none (it is not an image, or previews are switched off).
    const previewPath = path.join(storage.getPreviewDir(targetPath), req.file.originalname)
    try {
      await fs.rm(previewPath, { recursive: true, force: true })
    } catch (err: unknown) {
      console.error(`[thumbnail] Failed to delete the old preview of ${req.file.originalname}:`, err)
    }

    if (settings.createImagePreviews && THUMBNAIL_MIME_TYPES.has(mime)) {
      try {
        await generateThumbnail(uploadedFilePath, previewPath)
        file.preview = `/api/preview?path=${encodeURIComponent(file.path)}`
      } catch (err: unknown) {
        console.error(`[thumbnail] Failed to generate preview for ${req.file.originalname}:`, err)
      }
    }

    res.json(file)
  } catch (error: any) {
    // Before answering: a stored upload was moved out of temp/; whatever is still there was refused.
    if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {})
    sendError(res, error)
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
    sendError(res, error)
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
    sendError(res, error)
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
    sendError(res, error)
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
    sendError(res, error)
  }
})

router.get('/search', searchLimit, async (req, res) => {
  try {
    const query = req.query.query
    const dirPath = (req.query.path as string) || '/'
    const limitRaw = req.query.limit !== undefined ? parseInt(req.query.limit as string, 10) : 200
    const limit = Math.min(isNaN(limitRaw) ? 200 : limitRaw, 200)

    if (typeof query !== 'string' || !query.trim()) {
      return res.status(400).json({ error: 'query (non-empty string) required' })
    }

    const result = await getStorage().search(dirPath, query.trim(), limit)
    res.json(result)
  } catch (error: any) {
    sendError(res, error)
  }
})

export { router as filesRouter }
