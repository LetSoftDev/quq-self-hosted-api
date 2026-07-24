import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'

export const OPTIMIZABLE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/avif',
])

export interface ImageOptimizationResult {
  optimized: boolean
  originalSize: number
  outputSize: number
}

function withBrowserOptimizationPipeline(sourcePath: string, mime: string): sharp.Sharp | null {
  const base = sharp(sourcePath).rotate()

  if (mime === 'image/jpeg') {
    return base.jpeg({ quality: 88, progressive: true, mozjpeg: true })
  }
  if (mime === 'image/png') {
    return base.png({ compressionLevel: 9, adaptiveFiltering: true })
  }
  if (mime === 'image/webp') {
    return base.webp({ quality: 90, effort: 4 })
  }
  if (mime === 'image/avif') {
    return base.avif({ quality: 90, effort: 4 })
  }

  return null
}

export async function optimizeImageForBrowser(sourcePath: string, mime: string): Promise<ImageOptimizationResult> {
  const original = await fs.stat(sourcePath)
  const pipeline = withBrowserOptimizationPipeline(sourcePath, mime)
  if (!pipeline) {
    return { optimized: false, originalSize: original.size, outputSize: original.size }
  }

  const tempPath = path.join(
    path.dirname(sourcePath),
    `.${path.basename(sourcePath)}.quq-optimized-${process.pid}-${Date.now()}`,
  )

  try {
    await pipeline.toFile(tempPath)
    const output = await fs.stat(tempPath)

    if (output.size < original.size) {
      await fs.rename(tempPath, sourcePath)
      return { optimized: true, originalSize: original.size, outputSize: output.size }
    }

    await fs.unlink(tempPath).catch(() => {})
    return { optimized: false, originalSize: original.size, outputSize: output.size }
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {})
    throw error
  }
}
