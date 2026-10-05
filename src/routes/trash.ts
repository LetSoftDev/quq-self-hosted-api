import { Router } from 'express'
import fs from 'fs/promises'
import path from 'path'
import crypto from 'crypto'
import { TrashStore, type TrashItem } from '../storage/trash'
import { authMiddleware } from '../middleware/auth'
import { getStorage, resetStorage } from './files'
import { RequestError, sendError } from '../http-errors'

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

/**
 * A trashed item's thumbnail (for a folder, its tree of thumbnails) waits under this name in the
 * item's trash folder: left in .previews, /api/preview would go on serving it to anyone.
 */
const STASHED_PREVIEW = '.preview'

/**
 * Whether an item's own name is the stash's path in its trash folder. As a disk that ignores case
 * or normalises names reads it: there `.PREVIEW` is `.preview`, and stashing the thumbnails would
 * replace the trashed item with them.
 */
const isStashName = (itemName: string): boolean => itemName.normalize('NFKC').toLowerCase() === STASHED_PREVIEW

const virtualPathOf = (uploadsDir: string, absPath: string): string =>
  '/' + path.relative(uploadsDir, absPath).split(path.sep).join('/')

/** Moves a file or a folder, if there is one, over whatever is at the destination. */
async function moveIfExists(from: string, to: string): Promise<void> {
  try {
    await fs.access(from)
  } catch {
    return
  }
  await fs.mkdir(path.dirname(to), { recursive: true })
  await fs.rm(to, { recursive: true, force: true })
  await fs.rename(from, to)
}

async function stashPreview(previewPath: string, itemTrashDir: string, itemName: string): Promise<void> {
  try {
    // An item with the stash's own name would share its path, so its thumbnails are not kept.
    if (!isStashName(itemName)) await moveIfExists(previewPath, path.join(itemTrashDir, STASHED_PREVIEW))
  } finally {
    // Nothing to remove after a move. Otherwise: better a lost thumbnail than a public one.
    await fs.rm(previewPath, { recursive: true, force: true })
  }
}

const exists = (target: string): Promise<boolean> => fs.access(target).then(() => true, () => false)

/**
 * The thumbnail (for a folder, the tree of them) that an older version left in .previews when it
 * trashed the item: there is no stash in its trash folder and nothing at its original path. A file
 * or a folder that is there now owns the thumbnail. Null when there is none, or when the stored
 * path is not one the storage accepts.
 */
async function legacyPreviewOf(item: TrashItem, itemTrashDir: string): Promise<string | null> {
  // An item with the stash's own name never had a stash: what is at that path is the item.
  if (!isStashName(item.name) && await exists(path.join(itemTrashDir, STASHED_PREVIEW))) return null

  let previewPath: string
  let originalPath: string
  try {
    previewPath = getStorage().getPreviewPath(item.original_path)
    originalPath = getStorage().resolvePublic(item.original_path)
  } catch {
    // Older versions stored the path as the request spelled it.
    return null
  }
  if (!(await exists(previewPath)) || await exists(originalPath)) return null
  return previewPath
}

/**
 * Moves the thumbnails of items trashed by an older version out of .previews, where /api/preview
 * serves them, into the items' trash folders. Returns how many items it did that for. Safe to run
 * on every start: an item that has its stash is left alone.
 */
export async function stashLegacyTrashPreviews(): Promise<number> {
  const trashDir = path.join(path.resolve(process.env.UPLOADS_DIR || './uploads'), '.trash')
  let stashed = 0

  // Oldest first, as they were trashed: a file trashed before its folder takes its own thumbnail,
  // and the folder's stash is left without it.
  for (const item of getTrashStore().all()) {
    try {
      const itemTrashDir = path.join(trashDir, item.id)
      // Without its trash folder the item cannot be restored, and there is nowhere to stash.
      const isDir = await fs.stat(itemTrashDir).then(stats => stats.isDirectory(), () => false)
      if (!isDir) continue

      const previewPath = await legacyPreviewOf(item, itemTrashDir)
      if (!previewPath) continue
      await stashPreview(previewPath, itemTrashDir, item.name)
      stashed++
    } catch (err) {
      // One item's failure must not leave the thumbnails of the others public.
      console.error(`[trash] Failed to hide the preview of ${item.name}:`, err)
    }
  }
  return stashed
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

    // No preview URL: a trashed item's thumbnail is not public.
    const files = pageItems.map(item => ({
      trashId: item.id,
      name: item.name,
      path: item.original_path,
      type: item.type,
      url: '/files' + item.original_path,
      modified: item.deleted_at,
    }))
    res.json({ files, total, hasMore: offset + files.length < total })
  } catch (error: any) {
    sendError(res, error)
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
        if (absPath === uploadsDir) continue
        const stats = await fs.stat(absPath)
        const type: 'file' | 'dir' = stats.isDirectory() ? 'dir' : 'file'
        // Both from the resolved path: the request may spell it `/a/b/..`, whose last segment is
        // not the item's name.
        const name = path.basename(absPath)
        const originalPath = virtualPathOf(uploadsDir, absPath)
        const id = crypto.randomUUID()
        const itemTrashDir = path.join(trashDir, id)
        await fs.mkdir(itemTrashDir, { recursive: true })
        await fs.rename(absPath, path.join(itemTrashDir, name))
        getTrashStore().add(id, originalPath, name, type)
        moved++
        try {
          await stashPreview(getStorage().getPreviewPath(originalPath), itemTrashDir, name)
        } catch (err) {
          console.error(`[trash] Failed to hide the preview of ${name}:`, err)
        }
      } catch {
        // skip individual failures
      }
    }

    res.json({ moved })
  } catch (error: any) {
    sendError(res, error)
  }
})

router.post('/trash/restore', async (req, res) => {
  try {
    // Anything but a string names no item (and SQLite cannot bind it).
    const id: unknown = req.body.id
    const item = typeof id === 'string' ? getTrashStore().getById(id) : undefined
    if (!item) return res.status(404).json({ error: 'Item not found in trash' })
    // Older versions stored the last segment of the request path: restoring `..` would move the
    // whole trash folder.
    if (!item.name || item.name === '.' || item.name === '..' || /[/\\]/.test(item.name)) {
      throw new RequestError('Invalid trash item')
    }

    const uploadsDir = path.resolve(process.env.UPLOADS_DIR || './uploads')
    const trashDir = path.join(uploadsDir, '.trash')
    const originalDest = getStorage().resolvePublic(item.original_path)
    const finalName = await getStorage().resolveConflictName(path.dirname(originalDest), item.name)
    const finalDest = path.join(path.dirname(originalDest), finalName)

    await fs.mkdir(path.dirname(finalDest), { recursive: true })
    await fs.rename(path.join(trashDir, item.id, item.name), finalDest)
    const restoredVirtualPath = virtualPathOf(uploadsDir, finalDest)
    try {
      await moveIfExists(path.join(trashDir, item.id, STASHED_PREVIEW), getStorage().getPreviewPath(restoredVirtualPath))
    } catch (err) {
      // The item is back; a thumbnail that cannot follow it is not worth failing the restore.
      console.error(`[trash] Failed to restore the preview of ${finalName}:`, err)
    }
    await fs.rm(path.join(trashDir, item.id), { recursive: true })
    getTrashStore().remove(item.id)

    res.json({ path: restoredVirtualPath })
  } catch (error: any) {
    sendError(res, error)
  }
})

router.post('/trash/delete', async (req, res) => {
  try {
    // Anything but a string names no item (and SQLite cannot bind it).
    const id: unknown = req.body.id
    const item = typeof id === 'string' ? getTrashStore().getById(id) : undefined
    if (!item) return res.status(404).json({ error: 'Item not found in trash' })

    const uploadsDir = path.resolve(process.env.UPLOADS_DIR || './uploads')
    const trashDir = path.join(uploadsDir, '.trash')
    const itemTrashDir = path.join(trashDir, item.id)

    // Of an item trashed by an older version that the pass at startup did not reach.
    const legacyPreview = await legacyPreviewOf(item, itemTrashDir)
    if (legacyPreview) await fs.rm(legacyPreview, { recursive: true, force: true })

    // The thumbnail goes with it: it was moved into this folder when the item was trashed.
    // Forced: a folder that is already gone must not keep its row in the trash for ever.
    await fs.rm(itemTrashDir, { recursive: true, force: true })
    getTrashStore().remove(item.id)
    res.json({ deleted: true })
  } catch (error: any) {
    sendError(res, error)
  }
})

export { router as trashRouter }
