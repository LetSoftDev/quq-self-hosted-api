import sharp from 'sharp'
import fs from 'fs/promises'
import path from 'path'

/**
 * Generate a 200x200 JPEG thumbnail from a source image file.
 * Supported input formats: JPEG, PNG, WebP, GIF, SVG (SVG requires librsvg in sharp build).
 * @param sourcePath Absolute path to the source image
 * @param destPath   Absolute path where the JPEG thumbnail should be saved
 */
export async function generateThumbnail(sourcePath: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true })
  await sharp(sourcePath)
    .resize(200, 200, { fit: 'cover' })
    .jpeg({ quality: 80 })
    .toFile(destPath)
}

/** MIME types that support thumbnail generation */
export const THUMBNAIL_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml',
])
