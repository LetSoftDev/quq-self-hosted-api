import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { generateThumbnail } from './thumbnails'

const TEST_DIR = path.join(process.cwd(), 'temp', 'test-thumbnails')
const FIXTURES_DIR = path.join(process.cwd(), 'temp', 'test-fixtures')

describe('generateThumbnail', () => {
  beforeEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true })
    await fs.mkdir(TEST_DIR, { recursive: true })
    await fs.mkdir(FIXTURES_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true })
    await fs.rm(FIXTURES_DIR, { recursive: true, force: true })
  })

  it('generates a JPEG thumbnail for a PNG file', async () => {
    const sharp = (await import('sharp')).default
    const pngPath = path.join(FIXTURES_DIR, 'test.png')
    await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 0, b: 0 } }
    }).png().toFile(pngPath)

    const previewPath = path.join(TEST_DIR, 'test.png.jpg')
    await generateThumbnail(pngPath, previewPath)

    const stats = await fs.stat(previewPath)
    expect(stats.size).toBeGreaterThan(0)

    // Verify it's a valid JPEG (starts with FF D8)
    const buf = Buffer.alloc(2)
    const fh = await fs.open(previewPath, 'r')
    await fh.read(buf, 0, 2, 0)
    await fh.close()
    expect(buf[0]).toBe(0xff)
    expect(buf[1]).toBe(0xd8)
  })

  it('creates parent directory if it does not exist', async () => {
    const sharp = (await import('sharp')).default
    const pngPath = path.join(FIXTURES_DIR, 'test2.png')
    await sharp({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 255, b: 0 } }
    }).png().toFile(pngPath)

    const nestedPreviewPath = path.join(TEST_DIR, 'nested', 'dir', 'test2.jpg')
    await generateThumbnail(pngPath, nestedPreviewPath)

    await expect(fs.access(nestedPreviewPath)).resolves.toBeUndefined()
  })
})
