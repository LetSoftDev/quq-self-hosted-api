import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi, type MockInstance } from 'vitest'
import express from 'express'
import request from 'supertest'
import { createApp } from '../app'
import { filesRouter, resetStorage } from './files'
import { resetStarStore, getStarStore } from './stars'
import fs from 'fs/promises'
import path from 'path'

vi.mock('../storage/image-optimization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../storage/image-optimization')>()
  return {
    ...actual,
    optimizeImageForBrowser: vi.fn().mockResolvedValue({
      optimized: false,
      originalSize: 100,
      outputSize: 100,
    }),
  }
})

const TEST_DIR = path.join(process.cwd(), 'temp', 'test-uploads')
const TEST_DATA_DIR = path.join(process.cwd(), 'temp', 'test-uploads-data')

describe.sequential('Files Router', () => {
  let app: express.Application

  beforeAll(async () => {
    // Set env vars before creating app
    process.env.UPLOADS_DIR = TEST_DIR

    // Ensure parent directory exists
    await fs.mkdir(path.dirname(TEST_DIR), { recursive: true })

    // Create initial test directory
    await fs.mkdir(TEST_DIR, { recursive: true })

    app = express()
    app.use(express.json())
    app.use('/api', filesRouter)
  })

  beforeEach(async () => {
    // Reset storage singleton so it picks up TEST_DIR
    resetStorage()
    resetStarStore()

    // Clean up and recreate test directory
    await fs.rm(TEST_DIR, { recursive: true, force: true })
    await fs.mkdir(TEST_DIR, { recursive: true })
    // Clean up star store data dir to avoid stale DB state
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true })
    process.env.DATA_DIR = TEST_DATA_DIR
  })

  afterEach(async () => {
    // Clean up after each test
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
  })

  afterAll(async () => {
    // Final cleanup
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
  })

  const tempFiles = async () => (await fs.readdir(path.join(process.cwd(), 'temp'), { withFileTypes: true }))
    .filter(entry => entry.isFile()).length

  describe('GET /api/list', () => {
    it('should return files array', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'test.txt'), 'content')

      const res = await request(app)
        .get('/api/list?path=/')
        .set('x-api-key', 'test-key')

      expect(res.status).toBe(200)
      expect(res.body.files).toBeInstanceOf(Array)
      expect(res.body.files[0].name).toBe('test.txt')
    })

    it('should require API key', async () => {
      const res = await request(app).get('/api/list?path=/')

      expect(res.status).toBe(401)
    })

    it('should return total and hasMore fields', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'test.txt'), 'content')

      const res = await request(app)
        .get('/api/list?path=/')
        .set('x-api-key', 'test-key')

      expect(res.status).toBe(200)
      expect(res.body.total).toBe(1)
      expect(res.body.hasMore).toBe(false)
    })

    it('should paginate with limit and offset', async () => {
      for (let i = 1; i <= 5; i++) {
        await fs.writeFile(path.join(TEST_DIR, `file${i}.txt`), '')
      }

      const res = await request(app)
        .get('/api/list?path=/&limit=2&offset=0')
        .set('x-api-key', 'test-key')

      expect(res.status).toBe(200)
      expect(res.body.files).toHaveLength(2)
      expect(res.body.total).toBe(5)
      expect(res.body.hasMore).toBe(true)
    })

    it('answers 404 for a missing folder without the server path', async () => {
      const res = await request(app).get('/api/list?path=/nope').set('x-api-key', 'test-key')

      expect(res.status).toBe(404)
      expect(res.body).toEqual({ error: 'Not found' })
    })

    it('answers 400 for a path outside the storage', async () => {
      const res = await request(app).get('/api/list?path=/../x').set('x-api-key', 'test-key')

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'path traversal detected' })
    })
  })

  describe('POST /api/mkdir', () => {
    it('should create directory', async () => {
      const res = await request(app)
        .post('/api/mkdir')
        .set('x-api-key', 'test-key')
        .send({ path: '/newfolder' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)

      const stats = await fs.stat(path.join(TEST_DIR, 'newfolder'))
      expect(stats.isDirectory()).toBe(true)
    })
  })

  describe('POST /api/delete', () => {
    it('should delete files', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'delete.txt'), 'content')

      const res = await request(app)
        .post('/api/delete')
        .set('x-api-key', 'test-key')
        .send({ paths: ['/delete.txt'] })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)

      await expect(fs.access(path.join(TEST_DIR, 'delete.txt'))).rejects.toThrow()
    })
  })

  describe('POST /api/delete — thumbnails', () => {
    it('stops serving the thumbnails of a deleted folder', async () => {
      const sharp = (await import('sharp')).default
      const pngBuffer = await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 100, g: 100, b: 100 } }
      }).png().toBuffer()
      await fs.mkdir(path.join(TEST_DIR, 'album'))
      await request(app)
        .post('/api/upload')
        .set('x-api-key', 'test-key')
        .field('path', '/album')
        .attach('file', pngBuffer, { filename: 'photo.png', contentType: 'image/png' })
        .expect(200)
      await request(app).get('/api/preview?path=%2Falbum%2Fphoto.png').expect(200)

      await request(app).post('/api/delete').set('x-api-key', 'test-key').send({ paths: ['/album'] }).expect(200)

      expect((await request(app).get('/api/preview?path=%2Falbum%2Fphoto.png')).status).toBe(404)
      await expect(fs.access(path.join(TEST_DIR, '.previews', 'album'))).rejects.toThrow()
    })
  })

  describe('POST /api/rename', () => {
    it('should rename a file', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'old.txt'), 'content')

      const res = await request(app)
        .post('/api/rename')
        .set('x-api-key', 'test-key')
        .send({ oldPath: '/old.txt', newPath: '/new.txt' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      await expect(fs.access(path.join(TEST_DIR, 'new.txt'))).resolves.toBeUndefined()
    })

    it('should return 400 when oldPath is missing', async () => {
      const res = await request(app)
        .post('/api/rename')
        .set('x-api-key', 'test-key')
        .send({ newPath: '/new.txt' })

      expect(res.status).toBe(400)
    })

    it('should return 400 when newPath is missing', async () => {
      const res = await request(app)
        .post('/api/rename')
        .set('x-api-key', 'test-key')
        .send({ oldPath: '/old.txt' })

      expect(res.status).toBe(400)
    })

    it('should auto-rename when destination already exists', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'a.txt'), 'a')
      await fs.writeFile(path.join(TEST_DIR, 'b.txt'), 'b')

      const res = await request(app)
        .post('/api/rename')
        .set('x-api-key', 'test-key')
        .send({ oldPath: '/a.txt', newPath: '/b.txt' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      // 'a.txt' moved to 'b (2).txt' because 'b.txt' already exists
      await expect(fs.access(path.join(TEST_DIR, 'b (2).txt'))).resolves.toBeUndefined()
      await expect(fs.access(path.join(TEST_DIR, 'a.txt'))).rejects.toThrow()
    })
  })

  describe('POST /api/copy', () => {
    it('should copy a file to a destination directory', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'original.txt'), 'hello')

      const res = await request(app)
        .post('/api/copy')
        .set('x-api-key', 'test-key')
        .send({ sources: ['/original.txt'], destDir: '/' })

      expect(res.status).toBe(200)
      expect(res.body.success).toBe(true)
      // original still exists
      await expect(fs.access(path.join(TEST_DIR, 'original.txt'))).resolves.toBeUndefined()
      // copy exists
      await expect(fs.access(path.join(TEST_DIR, 'original (2).txt'))).resolves.toBeUndefined()
    })

    it('should copy a file to a different directory', async () => {
      await fs.mkdir(path.join(TEST_DIR, 'subfolder'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, 'file.txt'), 'content')

      const res = await request(app)
        .post('/api/copy')
        .set('x-api-key', 'test-key')
        .send({ sources: ['/file.txt'], destDir: '/subfolder' })

      expect(res.status).toBe(200)
      await expect(fs.access(path.join(TEST_DIR, 'subfolder', 'file.txt'))).resolves.toBeUndefined()
      await expect(fs.access(path.join(TEST_DIR, 'file.txt'))).resolves.toBeUndefined()
    })

    it('should copy a directory recursively', async () => {
      await fs.mkdir(path.join(TEST_DIR, 'srcdir'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, 'srcdir', 'nested.txt'), 'nested')
      await fs.mkdir(path.join(TEST_DIR, 'destdir'), { recursive: true })

      const res = await request(app)
        .post('/api/copy')
        .set('x-api-key', 'test-key')
        .send({ sources: ['/srcdir'], destDir: '/destdir' })

      expect(res.status).toBe(200)
      await expect(fs.access(path.join(TEST_DIR, 'destdir', 'srcdir', 'nested.txt'))).resolves.toBeUndefined()
    })

    it('should return 400 when sources is missing', async () => {
      const res = await request(app)
        .post('/api/copy')
        .set('x-api-key', 'test-key')
        .send({ destDir: '/' })

      expect(res.status).toBe(400)
    })

    it('should return 400 when destDir is missing', async () => {
      const res = await request(app)
        .post('/api/copy')
        .set('x-api-key', 'test-key')
        .send({ sources: ['/file.txt'] })

      expect(res.status).toBe(400)
    })
  })

  describe('GET /api/preview', () => {
    it('should serve a preview JPEG file', async () => {
      await fs.mkdir(path.join(TEST_DIR, '.previews'), { recursive: true })
      const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
      await fs.writeFile(path.join(TEST_DIR, '.previews', 'photo.jpg'), jpegMagic)

      const res = await request(app)
        .get('/api/preview?path=%2Fphoto.jpg')
        .set('x-api-key', 'test-key')

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toContain('image/jpeg')
    })

    it('should return 404 when preview does not exist', async () => {
      const res = await request(app)
        .get('/api/preview?path=%2Fmissing.jpg')
        .set('x-api-key', 'test-key')

      expect(res.status).toBe(404)
    })

    it('should reject path traversal attempts', async () => {
      const res = await request(app)
        .get('/api/preview?path=..%2F..%2Fetc%2Fpasswd')
        .set('x-api-key', 'test-key')

      expect(res.status).toBe(400)
    })

    describe('internal folders', () => {
      // Whatever lies under .previews is public, so a path into an internal folder must not be
      // looked up there. The files exist: a 404 would pass for the wrong reason.
      beforeEach(async () => {
        await fs.mkdir(path.join(TEST_DIR, '.previews', '.trash', 'abc'), { recursive: true })
        await fs.mkdir(path.join(TEST_DIR, '.previews', '.previews'), { recursive: true })
        await fs.writeFile(path.join(TEST_DIR, '.previews', '.trash', 'abc', 'a.jpg'), 'trashed thumb')
        await fs.writeFile(path.join(TEST_DIR, '.previews', '.previews', 'a.jpg'), 'thumb')
      })

      it.each([
        '/.trash/abc/a.jpg',
        '/.previews/a.jpg',
        '.trash/abc/a.jpg',
        '/./.trash/abc/a.jpg',
        '/x/../.trash/abc/a.jpg',
        '/.TRASH/abc/a.jpg',
        '/.trash./abc/a.jpg',
      ])('does not serve %s', async internal => {
        const res = await request(app).get(`/api/preview?path=${encodeURIComponent(internal)}`)

        expect(res.status).toBe(400)
        expect(res.body).toEqual({ error: 'path not allowed' })
      })

      it('does not serve it behind a second leading slash either', async () => {
        const res = await request(app).get(`/api/preview?path=${encodeURIComponent('//.trash/abc/a.jpg')}`)

        expect(res.status).toBe(400)
        expect(res.body).toEqual({ error: 'absolute paths not allowed' })
      })

      it('still serves the thumbnail of a file in a folder with that name below the root', async () => {
        await fs.mkdir(path.join(TEST_DIR, '.previews', 'projects', '.trash'), { recursive: true })
        await fs.writeFile(path.join(TEST_DIR, '.previews', 'projects', '.trash', 'a.jpg'), 'thumb')

        const res = await request(app).get(`/api/preview?path=${encodeURIComponent('/projects/.trash/a.jpg')}`)

        expect(res.status).toBe(200)
      })
    })
  })

  describe('GET /api/search', () => {
    it('returns 400 if query is missing', async () => {
      const res = await request(app).get('/api/search?path=/').set('x-api-key', 'test-key')
      expect(res.status).toBe(400)
    })

    it('returns 400 if query is empty string', async () => {
      const res = await request(app).get('/api/search?query=&path=/').set('x-api-key', 'test-key')
      expect(res.status).toBe(400)
    })

    it('returns 200 with matching files', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'findme.txt'), 'x')
      const res = await request(app).get('/api/search?query=findme&path=/').set('x-api-key', 'test-key')
      expect(res.status).toBe(200)
      expect(res.body.files).toBeInstanceOf(Array)
      expect(res.body.files.map((f: any) => f.name)).toContain('findme.txt')
    })

    it('returns empty array when no match', async () => {
      const res = await request(app).get('/api/search?query=zzznomatch999&path=/').set('x-api-key', 'test-key')
      expect(res.status).toBe(200)
      expect(res.body.files).toHaveLength(0)
    })
  })

  describe('GET /api/list — starred annotation', () => {
    it('includes starred: true for a starred file', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'photo.jpg'), '')
      // Star it via the store directly
      getStarStore().toggle('/photo.jpg', 'photo.jpg', 'file')

      const res = await request(app)
        .get('/api/list?path=/')
        .set('x-api-key', 'test-key')

      expect(res.status).toBe(200)
      const file = res.body.files.find((f: any) => f.name === 'photo.jpg')
      expect(file?.starred).toBe(true)
    })

    it('does not include starred field for unstarred files', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'doc.txt'), '')

      const res = await request(app)
        .get('/api/list?path=/')
        .set('x-api-key', 'test-key')

      expect(res.status).toBe(200)
      const file = res.body.files.find((f: any) => f.name === 'doc.txt')
      expect(file?.starred).toBeUndefined()
    })
  })

  describe('POST /api/rename — star sync', () => {
    it('updates the star record when a starred file is renamed', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'old.txt'), 'content')
      getStarStore().toggle('/old.txt', 'old.txt', 'file')

      const renameRes = await request(app)
        .post('/api/rename')
        .set('x-api-key', 'test-key')
        .send({ oldPath: '/old.txt', newPath: '/new.txt' })
      expect(renameRes.status).toBe(200)

      expect(getStarStore().isStarred('/old.txt')).toBe(false)
      expect(getStarStore().isStarred('/new.txt')).toBe(true)
    })
  })

  describe('POST /api/upload', () => {
    it('should create thumbnail and return preview URL in response for image uploads', async () => {
      const sharp = (await import('sharp')).default
      const pngBuffer = await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 100, g: 100, b: 100 } }
      }).png().toBuffer()

      const res = await request(app)
        .post('/api/upload')
        .set('x-api-key', 'test-key')
        .field('path', '/')
        .attach('file', pngBuffer, { filename: 'photo.png', contentType: 'image/png' })

      expect(res.status).toBe(200)
      expect(res.body.name).toBe('photo.png')
      expect(res.body.preview).toBeDefined()
      expect(res.body.preview).toContain('/api/preview')

      const previewPath = path.join(TEST_DIR, '.previews', 'photo.png')
      await expect(fs.access(previewPath)).resolves.toBeUndefined()
    })

    it('should create thumbnail when uploading to a subfolder', async () => {
      await fs.mkdir(path.join(TEST_DIR, 'subfolder'), { recursive: true })

      const sharp = (await import('sharp')).default
      const pngBuffer = await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 100, g: 100, b: 100 } }
      }).png().toBuffer()

      const res = await request(app)
        .post('/api/upload')
        .set('x-api-key', 'test-key')
        .field('path', '/subfolder')
        .attach('file', pngBuffer, { filename: 'photo.png', contentType: 'image/png' })

      expect(res.status).toBe(200)
      expect(res.body.preview).toBeDefined()
      expect(res.body.preview).toContain('/api/preview')

      const previewPath = path.join(TEST_DIR, '.previews', 'subfolder', 'photo.png')
      await expect(fs.access(previewPath)).resolves.toBeUndefined()
    })

    it('should not create thumbnail for non-image uploads', async () => {
      const res = await request(app)
        .post('/api/upload')
        .set('x-api-key', 'test-key')
        .field('path', '/')
        .attach('file', Buffer.from('hello'), { filename: 'doc.txt', contentType: 'text/plain' })

      expect(res.status).toBe(200)
      expect(res.body.preview).toBeUndefined()
      const previewPath = path.join(TEST_DIR, '.previews', 'doc.txt')
      await expect(fs.access(previewPath)).rejects.toThrow()
    })

    it('should not create image previews when project setting is disabled', async () => {
      ;(fetch as any).mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          valid: true,
          settings: {
            createImagePreviews: false,
            optimizeImages: true,
          },
        }),
      })

      const sharp = (await import('sharp')).default
      const pngBuffer = await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 100, g: 100, b: 100 } }
      }).png().toBuffer()

      const res = await request(app)
        .post('/api/upload')
        .set('x-api-key', 'preview-off-key')
        .field('path', '/')
        .attach('file', pngBuffer, { filename: 'photo.png', contentType: 'image/png' })

      expect(res.status).toBe(200)
      expect(res.body.preview).toBeUndefined()
      const previewPath = path.join(TEST_DIR, '.previews', 'photo.png')
      await expect(fs.access(previewPath)).rejects.toThrow()
    })

    it('does not optimize image uploads on free projects', async () => {
      const { optimizeImageForBrowser } = await import('../storage/image-optimization')
      vi.mocked(optimizeImageForBrowser).mockClear()
      ;(fetch as any).mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          valid: true,
          plan: 'free',
          settings: {
            createImagePreviews: true,
            optimizeImages: true,
            canOptimizeImages: false,
            effectiveOptimizeImages: false,
          },
        }),
      })

      const sharp = (await import('sharp')).default
      const pngBuffer = await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 100, g: 100, b: 100 } }
      }).png().toBuffer()

      const res = await request(app)
        .post('/api/upload')
        .set('x-api-key', 'free-optimization-key')
        .field('path', '/')
        .attach('file', pngBuffer, { filename: 'free.png', contentType: 'image/png' })

      expect(res.status).toBe(200)
      expect(optimizeImageForBrowser).not.toHaveBeenCalled()
    })

    it('optimizes image uploads on custom projects when preference is enabled', async () => {
      const { optimizeImageForBrowser } = await import('../storage/image-optimization')
      vi.mocked(optimizeImageForBrowser).mockClear()
      ;(fetch as any).mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          valid: true,
          plan: 'custom',
          settings: {
            createImagePreviews: true,
            optimizeImages: true,
            canOptimizeImages: true,
            effectiveOptimizeImages: true,
          },
        }),
      })

      const sharp = (await import('sharp')).default
      const pngBuffer = await sharp({
        create: { width: 10, height: 10, channels: 3, background: { r: 100, g: 100, b: 100 } }
      }).png().toBuffer()

      const res = await request(app)
        .post('/api/upload')
        .set('x-api-key', 'custom-optimization-key')
        .field('path', '/')
        .attach('file', pngBuffer, { filename: 'custom.png', contentType: 'image/png' })

      expect(res.status).toBe(200)
      expect(optimizeImageForBrowser).toHaveBeenCalled()
    })

    it('removes the temp file of a rejected upload', async () => {
      const before = await tempFiles()

      const res = await request(app)
        .post('/api/upload')
        .set('x-api-key', 'test-key')
        .field('path', '/../outside')
        .attach('file', Buffer.from('x'), 'a.txt')

      expect(res.status).toBeGreaterThanOrEqual(400)
      expect(await tempFiles()).toBe(before)
    })

    it('leaves no temp file after a successful upload', async () => {
      const before = await tempFiles()

      await request(app)
        .post('/api/upload')
        .set('x-api-key', 'test-key')
        .field('path', '/')
        .attach('file', Buffer.from('x'), 'a.txt')
        .expect(200)

      expect(await tempFiles()).toBe(before)
    })

    it('keeps a non-ASCII file name as the browser sent it', async () => {
      const name = 'Отчёт "1".txt'

      const res = await request(app)
        .post('/api/upload')
        .set('x-api-key', 'test-key')
        .field('path', '/')
        .attach('file', Buffer.from('x'), name)

      expect(res.status).toBe(200)
      expect(res.body.name).toBe(name)
      expect(await fs.readdir(TEST_DIR)).toEqual([name])
      const list = await request(app).get('/api/list?path=/').set('x-api-key', 'test-key')
      expect(list.body.files.map((file: { name: string }) => file.name)).toEqual([name])
    })

    it('does not treat a file as an image because the client says so', async () => {
      const res = await request(app)
        .post('/api/upload')
        .set('x-api-key', 'test-key')
        .field('path', '/')
        .attach('file', Buffer.from('<script>1</script>'), { filename: 'page.html', contentType: 'image/png' })

      expect(res.status).toBe(200)
      expect(res.body.mime).toBe('text/html')
      expect(res.body.preview).toBeUndefined()
      await expect(fs.access(path.join(TEST_DIR, '.previews', 'page.html'))).rejects.toThrow()
    })
  })

  // /api/preview serves whatever is in .previews: a thumbnail must not outlive the picture it shows.
  describe('POST /api/upload over an existing file', () => {
    let log: MockInstance

    beforeEach(() => {
      log = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      log.mockRestore()
    })

    const picture = async (shade: number): Promise<Buffer> => {
      const sharp = (await import('sharp')).default
      return sharp({ create: { width: 10, height: 10, channels: 3, background: { r: shade, g: shade, b: shade } } }).png().toBuffer()
    }
    const upload = (apiKey: string, content: Buffer, dir = '/') =>
      request(app).post('/api/upload').set('x-api-key', apiKey).field('path', dir).attach('file', content, 'photo.png')
    const preview = (virtualPath = '/photo.png') => request(app).get(`/api/preview?path=${encodeURIComponent(virtualPath)}`)

    it('stops serving the old thumbnail when the new content is not an image', async () => {
      await upload('test-key', await picture(100)).expect(200)
      expect((await preview()).status).toBe(200)

      const res = await upload('test-key', Buffer.from('not a picture any more'))

      expect(res.status).toBe(200)
      expect(res.body.preview).toBeUndefined()
      expect((await preview()).status).toBe(404)
      const list = await request(app).get('/api/list?path=/').set('x-api-key', 'test-key')
      expect(list.body.files[0].preview).toBeUndefined()
    })

    it('stops serving the old thumbnail when previews are switched off for the project', async () => {
      await upload('test-key', await picture(100), '/album').expect(200)
      expect((await preview('/album/photo.png')).status).toBe(200)
      ;(fetch as any).mockResolvedValueOnce({
        status: 200,
        json: async () => ({ valid: true, settings: { createImagePreviews: false } }),
      })

      const res = await upload('preview-off-key', await picture(200), '/album')

      expect(res.status).toBe(200)
      expect(res.body.preview).toBeUndefined()
      expect((await preview('/album/photo.png')).status).toBe(404)
    })

    it('replaces the thumbnail when the new content is an image', async () => {
      await upload('test-key', await picture(0)).expect(200)
      const before = (await preview()).body as Buffer

      const res = await upload('test-key', await picture(255))

      expect(res.body.preview).toContain('/api/preview')
      const after = await preview()
      expect(after.status).toBe(200)
      expect(Buffer.compare(after.body, before)).not.toBe(0)
    })

    it('leaves the thumbnail alone when the upload is refused', async () => {
      await upload('test-key', await picture(100)).expect(200)

      const res = await request(app)
        .post('/api/upload')
        .set('x-api-key', 'test-key')
        .field('path', '/photo.png')
        .attach('file', Buffer.from('x'), '..')

      expect(res.status).toBe(400)
      expect((await preview()).status).toBe(200)
    })
  })

  // Here and not in app.test.ts: every upload goes through temp/, whose files the tests above
  // count, so all uploads have to run in this one file, one after another.
  describe('POST /api/upload through the whole app', () => {
    let fullApp: express.Application
    let log: MockInstance

    beforeAll(() => {
      fullApp = createApp()
    })

    beforeEach(() => {
      log = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      log.mockRestore()
      delete process.env.RATE_LIMIT_UPLOAD
    })

    const key = { 'x-api-key': 'test-key' }

    /** A JSON answer that tells nothing about the server, is not logged as its fault and keeps no file. */
    const expectRefused = async (res: request.Response, status: number, body: object) => {
      expect(res.status).toBe(status)
      expect(res.body).toEqual(body)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.text).not.toContain(process.cwd())
      expect(log).not.toHaveBeenCalled()
      expect(await tempFiles()).toBe(0)
    }

    // The same route, written four ways. A limiter mounted on a path prefix misses the second.
    it.each([
      ['/api/upload', '203.0.1.1'],
      ['/api//upload', '203.0.1.2'],
      ['/api/upload/', '203.0.1.3'],
      ['/API/UPLOAD', '203.0.1.4'],
    ])('limits uploads sent to %s', async (url, ip) => {
      process.env.RATE_LIMIT_UPLOAD = '1'
      const upload = () => request(fullApp)
        .post(url)
        .set(key)
        .set('X-Forwarded-For', ip)
        .field('path', '/')
        .attach('file', Buffer.from('x'), 'limited.txt')

      expect((await upload()).status).toBe(200)
      expect((await upload()).status).toBe(429)
      expect(await tempFiles()).toBe(0)
    })

    it('answers 400 to an upload named like an existing folder', async () => {
      await fs.mkdir(path.join(TEST_DIR, 'docs'))

      const res = await request(fullApp).post('/api/upload').set(key).field('path', '/').attach('file', Buffer.from('x'), 'docs')

      await expectRefused(res, 400, { error: 'Invalid request' })
      expect((await fs.stat(path.join(TEST_DIR, 'docs'))).isDirectory()).toBe(true)
    })

    it('answers 400 to an upload with the path given twice', async () => {
      const res = await request(fullApp)
        .post('/api/upload')
        .set(key)
        .field('path', '/docs')
        .field('path', '/')
        .attach('file', Buffer.from('x'), 'twice.txt')

      await expectRefused(res, 400, { error: 'Invalid path' })
    })

    const multipart = (contentType: string, body: string) =>
      request(fullApp).post('/api/upload').set(key).set('Content-Type', contentType).send(Buffer.from(body))
    const part = '--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nabc'

    it.each([
      ['a file in the wrong field', () => request(fullApp).post('/api/upload').set(key).attach('upload', Buffer.from('x'), 'a.txt')],
      ['two files', () => request(fullApp).post('/api/upload').set(key).attach('file', Buffer.from('x'), 'a.txt').attach('file', Buffer.from('y'), 'b.txt')],
      ['no boundary', () => multipart('multipart/form-data', part)],
      ['a body that ends in the middle of a file', () => multipart('multipart/form-data; boundary=x', part)],
      ['a broken part header', () => multipart('multipart/form-data; boundary=x', '--x\r\nContent-Disposition\r\n\r\nabc\r\n--x--\r\n')],
      ['another multipart type', () => multipart('multipart/mixed; boundary=x', `${part}\r\n--x--\r\n`)],
    ])('answers 400 to an upload with %s', async (_what, send) => {
      const res = await send()

      await expectRefused(res, 400, { error: 'Invalid upload' })
      expect(await fs.readdir(TEST_DIR)).toEqual([])
    })
  })
})
