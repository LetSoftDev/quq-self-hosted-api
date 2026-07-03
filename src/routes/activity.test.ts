import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { activityRouter, resetActivityStore } from './activity'
import { resetStorage } from './files'
import fs from 'fs/promises'
import path from 'path'

const TEST_DIR = path.join(process.cwd(), 'temp', 'test-activity')
const TEST_UPLOADS_DIR = path.join(process.cwd(), 'temp', 'test-activity-uploads')

describe.sequential('Activity Router', () => {
  let app: express.Application

  beforeAll(async () => {
    process.env.DATA_DIR = TEST_DIR
    process.env.UPLOADS_DIR = TEST_UPLOADS_DIR
    await fs.mkdir(TEST_DIR, { recursive: true })
    await fs.mkdir(TEST_UPLOADS_DIR, { recursive: true })

    app = express()
    app.use(express.json())
    app.use('/api', activityRouter)
  })

  beforeEach(async () => {
    resetActivityStore()
    resetStorage()
    await fs.rm(TEST_DIR, { recursive: true, force: true })
    await fs.rm(TEST_UPLOADS_DIR, { recursive: true, force: true })
    await fs.mkdir(TEST_DIR, { recursive: true })
    await fs.mkdir(TEST_UPLOADS_DIR, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.rm(TEST_UPLOADS_DIR, { recursive: true, force: true }).catch(() => {})
  })

  afterAll(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {})
    await fs.rm(TEST_UPLOADS_DIR, { recursive: true, force: true }).catch(() => {})
  })

  describe('POST /api/activity', () => {
    it('returns 204 on valid body', async () => {
      const res = await request(app)
        .post('/api/activity')
        .set('x-api-key', 'test-key')
        .send({ path: '/docs/report.pdf', name: 'report.pdf', type: 'file' })
      expect(res.status).toBe(204)
    })

    it('returns 400 when path is missing', async () => {
      const res = await request(app)
        .post('/api/activity')
        .set('x-api-key', 'test-key')
        .send({ name: 'report.pdf', type: 'file' })
      expect(res.status).toBe(400)
    })

    it('returns 400 when name is missing', async () => {
      const res = await request(app)
        .post('/api/activity')
        .set('x-api-key', 'test-key')
        .send({ path: '/docs/report.pdf', type: 'file' })
      expect(res.status).toBe(400)
    })

    it('returns 400 when type is invalid', async () => {
      const res = await request(app)
        .post('/api/activity')
        .set('x-api-key', 'test-key')
        .send({ path: '/docs/report.pdf', name: 'report.pdf', type: 'unknown' })
      expect(res.status).toBe(400)
    })

    it('returns 401 when x-api-key is missing', async () => {
      const res = await request(app)
        .post('/api/activity')
        .send({ path: '/docs/report.pdf', name: 'report.pdf', type: 'file' })
      expect(res.status).toBe(401)
    })
  })

  describe('GET /api/activity/summary', () => {
    it('returns 200 with quickAccess and recentFiles arrays', async () => {
      const res = await request(app)
        .get('/api/activity/summary')
        .set('x-api-key', 'test-key')
      expect(res.status).toBe(200)
      expect(res.body).toHaveProperty('quickAccess')
      expect(res.body).toHaveProperty('recentFiles')
      expect(res.body.quickAccess).toBeInstanceOf(Array)
      expect(res.body.recentFiles).toBeInstanceOf(Array)
    })

    it('returns recorded item in recentFiles', async () => {
      await fs.mkdir(path.join(TEST_UPLOADS_DIR, 'docs'), { recursive: true })
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'docs', 'report.pdf'), 'test pdf')

      await request(app)
        .post('/api/activity')
        .set('x-api-key', 'test-key')
        .send({ path: '/docs/report.pdf', name: 'report.pdf', type: 'file' })

      const res = await request(app)
        .get('/api/activity/summary')
        .set('x-api-key', 'test-key')
      expect(res.body.recentFiles.map((f: any) => f.name)).toContain('report.pdf')
    })

    it('adds mime and preview metadata for recorded image files', async () => {
      await fs.mkdir(path.join(TEST_UPLOADS_DIR, 'images'), { recursive: true })
      await fs.mkdir(path.join(TEST_UPLOADS_DIR, '.previews', 'images'), { recursive: true })
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'images', 'photo.png'), 'image')
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, '.previews', 'images', 'photo.png'), 'preview')

      await request(app)
        .post('/api/activity')
        .set('x-api-key', 'test-key')
        .send({ path: '/images/photo.png', name: 'photo.png', type: 'file' })

      const res = await request(app)
        .get('/api/activity/summary')
        .set('x-api-key', 'test-key')

      expect(res.body.quickAccess[0]).toMatchObject({
        name: 'photo.png',
        mime: 'image/png',
        preview: '/api/preview?path=%2Fimages%2Fphoto.png',
      })
      expect(res.body.recentFiles[0]).toMatchObject({
        name: 'photo.png',
        mime: 'image/png',
        preview: '/api/preview?path=%2Fimages%2Fphoto.png',
      })
    })

    it('filters out recorded files that no longer exist in uploads', async () => {
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'existing.pdf'), 'test pdf')

      await request(app)
        .post('/api/activity')
        .set('x-api-key', 'test-key')
        .send({ path: '/missing.pdf', name: 'missing.pdf', type: 'file' })
      await request(app)
        .post('/api/activity')
        .set('x-api-key', 'test-key')
        .send({ path: '/existing.pdf', name: 'existing.pdf', type: 'file' })

      const res = await request(app)
        .get('/api/activity/summary')
        .set('x-api-key', 'test-key')

      expect(res.body.recentFiles.map((f: any) => f.name)).toContain('existing.pdf')
      expect(res.body.recentFiles.map((f: any) => f.name)).not.toContain('missing.pdf')
      expect(res.body.quickAccess.map((f: any) => f.name)).not.toContain('missing.pdf')
    })

    it('returns 401 when x-api-key is missing', async () => {
      const res = await request(app).get('/api/activity/summary')
      expect(res.status).toBe(401)
    })
  })
})
