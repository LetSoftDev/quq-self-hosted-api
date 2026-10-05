import fs from 'fs/promises'
import path from 'path'
import { isReservedRootName } from './local'

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

/**
 * Whether a file is stored at this path, relative to the storage root. A link is not followed, and
 * what is in the trash is not live. An error other than "nothing there" is thrown: a thumbnail is
 * not removed because its file could not be looked at.
 */
async function isLiveFile(root: string, relativePath: string): Promise<boolean> {
  if (isReservedRootName(relativePath.split(path.sep)[0])) return false
  try {
    return (await fs.lstat(path.join(root, relativePath))).isFile()
  } catch (error) {
    if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') return false
    throw error
  }
}

/** Sweeps one folder of .previews; returns how many thumbnails it removed there and below. */
async function sweep(root: string, previewsRoot: string, relativeDir: string): Promise<number> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(path.join(previewsRoot, relativeDir), { withFileTypes: true })
  } catch (error) {
    console.error(`[thumbnail] Failed to read .previews/${relativeDir}:`, error)
    return 0
  }

  let removed = 0
  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name)
    const previewPath = path.join(previewsRoot, relativePath)
    // One entry's failure must not leave the orphans next to it public.
    try {
      if (entry.isDirectory()) {
        removed += await sweep(root, previewsRoot, relativePath)
        // rmdir, not rm: it refuses a folder that still has anything in it.
        await fs.rmdir(previewPath).catch((error) => {
          if (codeOf(error) !== 'ENOTEMPTY' && codeOf(error) !== 'EEXIST') throw error
        })
      } else if (entry.isFile() && !(await isLiveFile(root, relativePath))) {
        await fs.unlink(previewPath)
        removed++
      }
      // A link, here or as a folder, is neither followed nor removed: the server did not make it.
    } catch (error) {
      console.error(`[thumbnail] Failed to clean up .previews/${relativePath}:`, error)
    }
  }
  return removed
}

/**
 * Removes every thumbnail whose file is no longer stored at the same path, then the folders that
 * are left empty. /api/preview serves whatever is in .previews without a key, and older versions
 * left thumbnails behind: of deleted folders, and of trashed items the stash could not take
 * (see `stashLegacyTrashPreviews`, which has to run first). Returns how many it removed.
 *
 * Works inside .previews only. Never throws for a single entry, and is safe to run on every start.
 */
export async function removeOrphanPreviews(): Promise<number> {
  const root = path.resolve(process.env.UPLOADS_DIR || './uploads')
  const previewsRoot = path.join(root, '.previews')
  // lstat: a .previews that is a link leads out of the storage, and nothing there is ours to remove.
  const isFolder = await fs.lstat(previewsRoot).then(stats => stats.isDirectory(), () => false)
  return isFolder ? sweep(root, previewsRoot, '') : 0
}
