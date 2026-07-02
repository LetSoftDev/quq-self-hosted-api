import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import { authMiddleware } from '../middleware/auth'

const router = Router()

router.use(authMiddleware)

router.get('/storage', async (req, res) => {
  try {
    const uploadsDir = path.resolve(process.env.UPLOADS_DIR || './uploads')
    const previewsPrefix = path.join(uploadsDir, '.previews') + path.sep
    const trashPrefix = path.join(uploadsDir, '.trash') + path.sep

    // Compute used: recursive size of uploadsDir, excluding .previews and .trash
    let used = 0
    try {
      const entries = await fs.readdir(uploadsDir, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile()) continue
        const fullPath = path.join(entry.parentPath, entry.name)
        if (fullPath.startsWith(previewsPrefix)) continue
        if (fullPath.startsWith(trashPrefix)) continue
        const stats = await fs.stat(fullPath)
        used += stats.size
      }
    } catch (err: any) {
      if (err.code !== 'ENOENT') throw err
      // UPLOADS_DIR doesn't exist yet — used stays 0
    }

    // Compute available: free disk space available to the process
    // Walk up until we find an existing path (handles deeply nested missing dirs)
    let statfsTarget = uploadsDir
    while (true) {
      try {
        await fs.access(statfsTarget)
        break
      } catch {
        const parent = path.dirname(statfsTarget)
        if (parent === statfsTarget) break // reached filesystem root
        statfsTarget = parent
      }
    }
    const diskStats = await fs.statfs(statfsTarget)
    const total = diskStats.bavail * diskStats.bsize

    res.json({ used, total })
  } catch (error: any) {
    res.status(500).json({ error: error.message })
  }
})

export { router as storageRouter }
