import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { filesRouter, resetStorage } from './files'
import { resetStarStore, getStarStore } from './stars'
import fs from 'fs/promises'
import path from 'path'

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
  })
})
