import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { storageRouter } from './storage'
import fs from 'fs/promises'
import path from 'path'

const TEST_UPLOADS_DIR = path.join(process.cwd(), 'temp', 'test-storage-routes')

describe.sequential('Storage Router', () => {
  let app: express.Application

  beforeAll(async () => {
    process.env.UPLOADS_DIR = TEST_UPLOADS_DIR
    app = express()
    app.use(express.json())
    app.use('/api', storageRouter)
  })

  beforeEach(async () => {
    await fs.rm(TEST_UPLOADS_DIR, { recursive: true, force: true })
    await fs.mkdir(TEST_UPLOADS_DIR, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(TEST_UPLOADS_DIR, { recursive: true, force: true }).catch(() => {})
  })

  it('returns shape { used, total } with numeric values', async () => {
    const res = await request(app).get('/api/storage').set('x-api-key', 'test-key')
    expect(res.status).toBe(200)
    expect(typeof res.body.used).toBe('number')
    expect(typeof res.body.total).toBe('number')
  })

  it('used is non-negative', async () => {
    const res = await request(app).get('/api/storage').set('x-api-key', 'test-key')
    expect(res.body.used).toBeGreaterThanOrEqual(0)
  })

  it('total is positive', async () => {
    const res = await request(app).get('/api/storage').set('x-api-key', 'test-key')
    expect(res.body.total).toBeGreaterThan(0)
  })

  it('counts actual file bytes in used', async () => {
    await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'hello.txt'), 'hello world') // 11 bytes
    const res = await request(app).get('/api/storage').set('x-api-key', 'test-key')
    expect(res.body.used).toBe(11)
  })

  it('does not count .previews files in used', async () => {
    const previewsDir = path.join(TEST_UPLOADS_DIR, '.previews')
    await fs.mkdir(previewsDir, { recursive: true })
    await fs.writeFile(path.join(previewsDir, 'thumb.jpg'), 'thumbnail data') // 14 bytes, excluded
    const res = await request(app).get('/api/storage').set('x-api-key', 'test-key')
    expect(res.body.used).toBe(0) // only .previews files exist, none counted
  })

  it('returns used: 0 when UPLOADS_DIR does not exist', async () => {
    await fs.rm(TEST_UPLOADS_DIR, { recursive: true, force: true })
    const res = await request(app).get('/api/storage').set('x-api-key', 'test-key')
    expect(res.status).toBe(200)
    expect(res.body.used).toBe(0)
    expect(res.body.total).toBeGreaterThan(0)
  })

  it('returns 401 without auth key', async () => {
    const res = await request(app).get('/api/storage')
    expect(res.status).toBe(401)
  })
})
