import fs from 'fs/promises'
import path from 'path'
import { isReservedRootName } from '../storage/local'

/**
 * Calls `onFile` for every file under `root`, folder by folder. Apart from generate-previews.ts,
 * which runs on import, so that the walk can be tested.
 */
export async function walkUploads(
  root: string,
  onFile: (fullPath: string) => Promise<void>,
  onUnreadableDir: (dir: string, err: unknown) => void,
  dir: string = root
): Promise<void> {
  let entries: import('fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    onUnreadableDir(dir, err)
    return
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      // Skip the .previews directory itself
      if (entry.name === '.previews') continue
      // And the internal folders of the root: a thumbnail made for a trashed file would be public.
      if (dir === root && isReservedRootName(entry.name)) continue
      await walkUploads(root, onFile, onUnreadableDir, fullPath)
      continue
    }

    if (entry.isFile()) await onFile(fullPath)
  }
}
