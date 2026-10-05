/**
 * Generate preview thumbnails for all images in the uploads directory.
 *
 * Usage:
 *   npx tsx src/scripts/generate-previews.ts [--uploads-dir ./uploads] [--force]
 *
 * Options:
 *   --uploads-dir <path>   Path to uploads directory (default: UPLOADS_DIR env or ./uploads)
 *   --force                Regenerate thumbnails even if they already exist
 */

import fs from 'fs/promises'
import path from 'path'
import { generateThumbnail, THUMBNAIL_MIME_TYPES } from '../storage/thumbnails.js'
import { walkUploads } from './walk-uploads.js'

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
}

function parseArgs(): { uploadsDir: string; force: boolean } {
  const args = process.argv.slice(2)
  let uploadsDir = process.env.UPLOADS_DIR || './uploads'
  let force = false

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--uploads-dir' && args[i + 1]) {
      uploadsDir = args[++i]
    } else if (args[i] === '--force') {
      force = true
    }
  }

  return { uploadsDir: path.resolve(uploadsDir), force }
}

async function generatePreview(
  fullPath: string,
  uploadsDir: string,
  previewsRoot: string,
  force: boolean,
  stats: { generated: number; skipped: number; failed: number }
): Promise<void> {
  const ext = path.extname(fullPath).toLowerCase()
  const mime = MIME_BY_EXT[ext]
  if (!mime || !THUMBNAIL_MIME_TYPES.has(mime)) return

  // Mirror the uploads structure inside .previews/
  const relPath = path.relative(uploadsDir, fullPath)
  const destPath = path.join(previewsRoot, relPath)

  if (!force) {
    try {
      await fs.access(destPath)
      console.log(`  [skip]  ${relPath}`)
      stats.skipped++
      return
    } catch {
      // Doesn't exist — generate it
    }
  }

  try {
    await generateThumbnail(fullPath, destPath)
    console.log(`  [ok]    ${relPath}`)
    stats.generated++
  } catch (err) {
    console.error(`  [fail]  ${relPath}`, err)
    stats.failed++
  }
}

async function main() {
  const { uploadsDir, force } = parseArgs()
  const previewsRoot = path.join(uploadsDir, '.previews')

  console.log(`Uploads dir : ${uploadsDir}`)
  console.log(`Previews dir: ${previewsRoot}`)
  console.log(`Force regen : ${force}`)
  console.log('')

  try {
    await fs.access(uploadsDir)
  } catch {
    console.error(`Uploads directory does not exist: ${uploadsDir}`)
    process.exit(1)
  }

  await fs.mkdir(previewsRoot, { recursive: true })

  const stats = { generated: 0, skipped: 0, failed: 0 }
  await walkUploads(
    uploadsDir,
    fullPath => generatePreview(fullPath, uploadsDir, previewsRoot, force, stats),
    (dir, err) => {
      console.error(`  [error] Cannot read directory: ${dir}`, err)
      stats.failed++
    }
  )

  console.log('')
  console.log(`Done. Generated: ${stats.generated}, Skipped: ${stats.skipped}, Failed: ${stats.failed}`)

  if (stats.failed > 0) process.exit(1)
}

main()
