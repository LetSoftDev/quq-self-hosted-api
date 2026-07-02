import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { starsRouter, resetStarStore } from './stars'
import fs from 'fs/promises'
import path from 'path'

const TEST_DATA_DIR = path.join(process.cwd(), 'temp', 'test-stars-routes')

describe.sequential('Stars Router', () => {
  let app: express.Application

  beforeAll(async () => {
    process.env.DATA_DIR = TEST_DATA_DIR
    await fs.mkdir(TEST_DATA_DIR, { recursive: true })
    app = express()
    app.use(express.json())
    app.use('/api', starsRouter)
  })

  beforeEach(() => {
    resetStarStore()
  })

  afterEach(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  afterAll(async () => {
    await fs.rm(TEST_DATA_DIR, { recursive: true, force: true }).catch(() => {})
  })

  describe('GET /api/stars', () => {
    it('returns empty ListResponse when no stars', async () => {
      const res = await request(app).get('/api/stars').set('x-api-key', 'test-key')
      expect(res.status).toBe(200)
      expect(res.body.files).toEqual([])
      expect(res.body.total).toBe(0)
      expect(res.body.hasMore).toBe(false)
    })

    it('returns starred items', async () => {
      await request(app)
        .post('/api/stars/toggle')
        .set('x-api-key', 'test-key')
        .send({ path: '/photo.jpg', name: 'photo.jpg', type: 'file' })

      const res = await request(app).get('/api/stars').set('x-api-key', 'test-key')
      expect(res.status).toBe(200)
      expect(res.body.files).toHaveLength(1)
      expect(res.body.files[0].name).toBe('photo.jpg')
      expect(res.body.files[0].url).toBe('/files/photo.jpg')
    })

    it('returns 401 without auth', async () => {
      const res = await request(app).get('/api/stars')
      expect(res.status).toBe(401)
    })

    it('supports pagination', async () => {
      for (let i = 1; i <= 5; i++) {
        await request(app)
          .post('/api/stars/toggle')
          .set('x-api-key', 'test-key')
          .send({ path: `/file${i}.txt`, name: `file${i}.txt`, type: 'file' })
      }
      const res = await request(app)
        .get('/api/stars?limit=2&offset=0')
        .set('x-api-key', 'test-key')
      expect(res.status).toBe(200)
      expect(res.body.files).toHaveLength(2)
      expect(res.body.total).toBe(5)
      expect(res.body.hasMore).toBe(true)
    })

    it('treats non-numeric offset as 0', async () => {
      await request(app)
        .post('/api/stars/toggle')
        .set('x-api-key', 'test-key')
        .send({ path: '/photo.jpg', name: 'photo.jpg', type: 'file' })
      const res = await request(app)
        .get('/api/stars?offset=abc')
        .set('x-api-key', 'test-key')
      expect(res.status).toBe(200)
      expect(res.body.files).toHaveLength(1)
    })
  })

  describe('POST /api/stars/toggle', () => {
    it('stars an item and returns { starred: true }', async () => {
      const res = await request(app)
        .post('/api/stars/toggle')
        .set('x-api-key', 'test-key')
        .send({ path: '/doc.pdf', name: 'doc.pdf', type: 'file' })
      expect(res.status).toBe(200)
      expect(res.body.starred).toBe(true)
    })

    it('un-stars an item on second call and returns { starred: false }', async () => {
      await request(app)
        .post('/api/stars/toggle')
        .set('x-api-key', 'test-key')
        .send({ path: '/doc.pdf', name: 'doc.pdf', type: 'file' })
      const res = await request(app)
        .post('/api/stars/toggle')
        .set('x-api-key', 'test-key')
        .send({ path: '/doc.pdf', name: 'doc.pdf', type: 'file' })
      expect(res.status).toBe(200)
      expect(res.body.starred).toBe(false)
    })

    it('returns 400 when path is missing', async () => {
      const res = await request(app)
        .post('/api/stars/toggle')
        .set('x-api-key', 'test-key')
        .send({ name: 'doc.pdf', type: 'file' })
      expect(res.status).toBe(400)
    })

    it('returns 400 when type is invalid', async () => {
      const res = await request(app)
        .post('/api/stars/toggle')
        .set('x-api-key', 'test-key')
        .send({ path: '/doc.pdf', name: 'doc.pdf', type: 'link' })
      expect(res.status).toBe(400)
    })

    it('returns 401 without auth', async () => {
      const res = await request(app)
        .post('/api/stars/toggle')
        .send({ path: '/doc.pdf', name: 'doc.pdf', type: 'file' })
      expect(res.status).toBe(401)
    })
  })
})
