import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { trashRouter, resetTrashStore } from './trash'
import { resetStorage } from './files'
import fs from 'fs/promises'
import path from 'path'

const TEST_UPLOADS_DIR = path.join(process.cwd(), 'temp', 'test-trash-routes')
const TEST_DATA_DIR = path.join(process.cwd(), 'temp', 'test-trash-data')

describe.sequential('Trash Router', () => {
  let app: express.Application

  beforeAll(async () => {
    process.env.UPLOADS_DIR = TEST_UPLOADS_DIR
    process.env.DATA_DIR = TEST_DATA_DIR
    await fs.mkdir(TEST_UPLOADS_DIR, { recursive: true })
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
    app = express()
    app.use(express.json())
    app.use('/api', trashRouter)
  })

  beforeEach(() => {
    resetTrashStore()
    resetStorage()
  })

  afterEach(async () => {
    await fs.rm(TEST_UPLOADS_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.mkdir(TEST_UPLOADS_DIR, { recursive: true })
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(path.join(process.cwd(), 'temp', 'test-trash-routes'), { recursive: true, force: true }).catch(() => {})
    await fs.rm(path.join(process.cwd(), 'temp', 'test-trash-data'), { recursive: true, force: true }).catch(() => {})
  })

  describe('GET /api/trash', () => {
    it('returns empty ListResponse when no items', async () => {
      const res = await request(app).get('/api/trash').set('x-api-key', 'test-key')
      expect(res.status).toBe(200)
      expect(res.body.files).toEqual([])
      expect(res.body.total).toBe(0)
      expect(res.body.hasMore).toBe(false)
    })

    it('returns trashed items with trashId', async () => {
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'file.txt'), 'hello')
      await request(app).post('/api/trash/move').set('x-api-key', 'test-key').send({ paths: ['/file.txt'] })
      const res = await request(app).get('/api/trash').set('x-api-key', 'test-key')
      expect(res.status).toBe(200)
      expect(res.body.files).toHaveLength(1)
      expect(typeof res.body.files[0].trashId).toBe('string')
      expect(res.body.files[0].name).toBe('file.txt')
      expect(res.body.total).toBe(1)
    })

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/trash')
      expect(res.status).toBe(401)
    })
  })

  describe('POST /api/trash/move', () => {
    it('moves a file to .trash and returns { moved: 1 }', async () => {
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'note.txt'), 'data')
      const res = await request(app)
        .post('/api/trash/move')
        .set('x-api-key', 'test-key')
        .send({ paths: ['/note.txt'] })
      expect(res.status).toBe(200)
      expect(res.body.moved).toBe(1)
      // File no longer at original location
      await expect(fs.access(path.join(TEST_UPLOADS_DIR, 'note.txt'))).rejects.toThrow()
    })

    it('moves a directory to .trash and stores type dir', async () => {
      await fs.mkdir(path.join(TEST_UPLOADS_DIR, 'myfolder'), { recursive: true })
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'myfolder', 'inner.txt'), 'x')
      const res = await request(app)
        .post('/api/trash/move')
        .set('x-api-key', 'test-key')
        .send({ paths: ['/myfolder'] })
      expect(res.status).toBe(200)
      expect(res.body.moved).toBe(1)
      // Verify type stored
      const listRes = await request(app).get('/api/trash').set('x-api-key', 'test-key')
      expect(listRes.body.files[0].type).toBe('dir')
    })

    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/trash/move').send({ paths: ['/x'] })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /api/trash/restore', () => {
    it('restores a file to its original path', async () => {
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'restore.txt'), 'hi')
      await request(app).post('/api/trash/move').set('x-api-key', 'test-key').send({ paths: ['/restore.txt'] })
      const listRes = await request(app).get('/api/trash').set('x-api-key', 'test-key')
      const { trashId } = listRes.body.files[0]

      const res = await request(app)
        .post('/api/trash/restore')
        .set('x-api-key', 'test-key')
        .send({ id: trashId })
      expect(res.status).toBe(200)
      expect(res.body.path).toBe('/restore.txt')
      await expect(fs.access(path.join(TEST_UPLOADS_DIR, 'restore.txt'))).resolves.toBeUndefined()
    })

    it('restores with suffix when original path is occupied', async () => {
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'dup.txt'), 'original')
      await request(app).post('/api/trash/move').set('x-api-key', 'test-key').send({ paths: ['/dup.txt'] })
      const listRes = await request(app).get('/api/trash').set('x-api-key', 'test-key')
      // Re-create the original file so there's a conflict
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'dup.txt'), 'blocker')

      const res = await request(app)
        .post('/api/trash/restore')
        .set('x-api-key', 'test-key')
        .send({ id: listRes.body.files[0].trashId })
      expect(res.status).toBe(200)
      expect(res.body.path).toBe('/dup (2).txt')
    })

    it('returns 404 for unknown id', async () => {
      const res = await request(app)
        .post('/api/trash/restore')
        .set('x-api-key', 'test-key')
        .send({ id: 'bad-id' })
      expect(res.status).toBe(404)
    })

    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/trash/restore').send({ id: 'x' })
      expect(res.status).toBe(401)
    })
  })

  describe('POST /api/trash/delete', () => {
    it('permanently removes from .trash', async () => {
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'gone.txt'), 'bye')
      await request(app).post('/api/trash/move').set('x-api-key', 'test-key').send({ paths: ['/gone.txt'] })
      const listRes = await request(app).get('/api/trash').set('x-api-key', 'test-key')
      const { trashId } = listRes.body.files[0]

      const res = await request(app)
        .post('/api/trash/delete')
        .set('x-api-key', 'test-key')
        .send({ id: trashId })
      expect(res.status).toBe(200)
      expect(res.body.deleted).toBe(true)
      // Item removed from store
      const afterList = await request(app).get('/api/trash').set('x-api-key', 'test-key')
      expect(afterList.body.total).toBe(0)
    })

    it('removes preview when file had one', async () => {
      const previewsDir = path.join(TEST_UPLOADS_DIR, '.previews')
      await fs.mkdir(previewsDir, { recursive: true })
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'img.jpg'), 'img')
      await fs.writeFile(path.join(previewsDir, 'img.jpg'), 'thumb')
      await request(app).post('/api/trash/move').set('x-api-key', 'test-key').send({ paths: ['/img.jpg'] })
      const listRes = await request(app).get('/api/trash').set('x-api-key', 'test-key')

      await request(app)
        .post('/api/trash/delete')
        .set('x-api-key', 'test-key')
        .send({ id: listRes.body.files[0].trashId })
      // Preview should be gone
      await expect(fs.access(path.join(previewsDir, 'img.jpg'))).rejects.toThrow()
    })

    it('does NOT attempt preview deletion for a directory', async () => {
      await fs.mkdir(path.join(TEST_UPLOADS_DIR, 'adir'), { recursive: true })
      await request(app).post('/api/trash/move').set('x-api-key', 'test-key').send({ paths: ['/adir'] })
      const listRes = await request(app).get('/api/trash').set('x-api-key', 'test-key')
      const res = await request(app)
        .post('/api/trash/delete')
        .set('x-api-key', 'test-key')
        .send({ id: listRes.body.files[0].trashId })
      expect(res.status).toBe(200)
    })

    it('returns 404 for unknown id', async () => {
      const res = await request(app)
        .post('/api/trash/delete')
        .set('x-api-key', 'test-key')
        .send({ id: 'nope' })
      expect(res.status).toBe(404)
    })

    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/trash/delete').send({ id: 'x' })
      expect(res.status).toBe(401)
    })
  })
})
