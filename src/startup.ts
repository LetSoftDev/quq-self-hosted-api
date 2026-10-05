import { stashLegacyTrashPreviews } from './routes/trash'
import { removeOrphanPreviews } from './storage/orphan-previews'

/**
 * Takes out of the public .previews folder what older versions left there. In this order: the
 * thumbnails of trashed items are moved to their stash first, and kept for a restore; whatever then
 * has no file is an orphan and is removed. Never rejects: the server runs with or without it, and
 * a failed first step does not stop the second (better a lost thumbnail than a public one).
 */
export async function tidyPreviews(): Promise<void> {
  // The server listens only after this: on a large store an operator should see why it does not yet.
  console.log('[thumbnail] Checking previews…')
  try {
    await stashLegacyTrashPreviews()
  } catch (error) {
    console.error('[trash] Failed to hide the previews of trashed items:', error)
  }
  try {
    const removed = await removeOrphanPreviews()
    if (removed > 0) console.log(`[thumbnail] Removed previews of files that are gone: ${removed}`)
  } catch (error) {
    console.error('[thumbnail] Failed to remove the previews of files that are gone:', error)
  }
}
