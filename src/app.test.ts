import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi, type MockInstance } from 'vitest'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import type { Application } from 'express'
import { createApp } from './app'

const DIR = path.join(process.cwd(), 'temp', 'test-app-uploads')
// Set as well: /api/list opens the stars database, which must never be the real data/ folder.
const DATA_DIR = path.join(process.cwd(), 'temp', 'test-app-data')

describe('createApp', () => {
  let app: Application

  beforeAll(async () => {
    await fs.rm(DIR, { recursive: true, force: true })
    await fs.rm(DATA_DIR, { recursive: true, force: true })
    await fs.mkdir(path.join(DIR, '.trash', 'abc'), { recursive: true })
    await fs.writeFile(path.join(DIR, 'page.html'), '<script>1</script>')
    await fs.writeFile(path.join(DIR, '.trash', 'abc', 'secret.txt'), 'trashed')
    process.env.UPLOADS_DIR = DIR
    process.env.DATA_DIR = DATA_DIR
    app = createApp()
  })

  afterAll(async () => {
    await fs.rm(DIR, { recursive: true, force: true })
    await fs.rm(DATA_DIR, { recursive: true, force: true })
  })

  it.each(['/files', '/uploads'])('serves %s through the safe file handler', async prefix => {
    const page = await request(app).get(`${prefix}/page.html`)
    expect(page.status).toBe(200)
    expect(page.headers['content-disposition']).toMatch(/^attachment/)
    expect(page.headers['access-control-allow-origin']).toBe('*')

    expect((await request(app).get(`${prefix}/.trash/abc/secret.txt`)).status).toBe(404)
  })

  it('answers the health check', async () => {
    const res = await request(app).get('/health')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ status: 'ok' })
  })

  it('does not announce Express', async () => {
    expect((await request(app).get('/health')).headers['x-powered-by']).toBeUndefined()
  })

  it('limits search harder than the rest of the API, and never the health check', async () => {
    process.env.RATE_LIMIT_SEARCH = '2'
    const limited = createApp()
    const search = () => request(limited).get('/api/search?query=a').set('x-api-key', 'test-key')

    expect((await search()).status).toBe(200)
    expect((await search()).status).toBe(200)
    expect((await search()).status).toBe(429)
    expect((await request(limited).get('/api/list').set('x-api-key', 'test-key')).status).toBe(200)
    expect((await request(limited).get('/health')).status).toBe(200)
    delete process.env.RATE_LIMIT_SEARCH
  })

  it('does not send Access-Control-Allow-Credentials: the API uses a header, not cookies', async () => {
    const res = await request(app).get('/health').set('Origin', 'https://site.example')

    expect(res.headers['access-control-allow-origin']).toBe('https://site.example')
    expect(res.headers['access-control-allow-credentials']).toBeUndefined()
  })

  it('answers malformed JSON with a JSON error and no stack trace', async () => {
    const res = await request(app)
      .post('/api/mkdir')
      .set('x-api-key', 'test-key')
      .set('Content-Type', 'application/json')
      .send('{bad')

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ error: 'Invalid request' })
    expect(res.text).not.toContain(process.cwd())
  })

  describe('rate limits', () => {
    // Each test counts under its own address: the limiters live as long as the routers do.
    const from = (ip: string) => ({ 'X-Forwarded-For': ip, 'x-api-key': 'test-key' })

    afterEach(() => {
      for (const name of ['API', 'UPLOAD', 'SEARCH', 'PREVIEW', 'STORAGE']) delete process.env[`RATE_LIMIT_${name}`]
    })

    // The same route, written four ways. A limiter mounted on a path prefix misses the second.
    // Uploads are limited the same way; that test is in routes/files.test.ts, with the other uploads.
    const spellings = (route: string, net: number): [string, string][] =>
      [`/api/${route}`, `/api//${route}`, `/api/${route}/`, `/API/${route.toUpperCase()}`].map((url, i) => [url, `203.0.${net}.${i + 1}`])

    it.each(spellings('search', 2))('limits searches sent to %s', async (url, ip) => {
      process.env.RATE_LIMIT_SEARCH = '1'
      const search = () => request(app).get(`${url}?query=a`).set(from(ip))

      expect((await search()).status).toBe(200)
      expect((await search()).status).toBe(429)
    })

    it.each(spellings('storage', 3))('limits storage usage requests sent to %s', async (url, ip) => {
      process.env.RATE_LIMIT_STORAGE = '1'
      const usage = () => request(app).get(url).set(from(ip))

      expect((await usage()).status).toBe(200)
      expect((await usage()).status).toBe(429)
    })

    it.each(spellings('preview', 4))('limits previews sent to %s on their own', async (url, ip) => {
      process.env.RATE_LIMIT_PREVIEW = '2'
      process.env.RATE_LIMIT_API = '1'
      const preview = () => request(app).get(`${url}?path=/none.jpg`).set('X-Forwarded-For', ip)

      // Not counted by the general limit of 1, only by their own.
      expect((await preview()).status).toBe(404)
      expect((await preview()).status).toBe(404)
      expect((await preview()).status).toBe(429)
      // And they do not use the general limit up.
      expect((await request(app).get('/api/list').set(from(ip))).status).toBe(200)
      expect((await request(app).get('/api/list').set(from(ip))).status).toBe(429)
    })

    // Only what an <img> sends is exempt from the general limit, not everything sent to that path.
    it.each(['post', 'put', 'patch', 'delete'] as const)('counts a %s to /api/preview under the general limit', async method => {
      process.env.RATE_LIMIT_API = '1'
      const ip = `203.0.7.${['post', 'put', 'patch', 'delete'].indexOf(method) + 1}`
      const send = () => request(app)[method]('/api/preview?path=/none.jpg').set(from(ip))

      expect((await send()).status).toBe(404)
      const second = await send()

      expect(second.status).toBe(429)
      expect(second.body).toEqual({ error: 'Too many requests', reason: 'rate_limited' })
    })

    it('does not count a HEAD of a preview under the general limit', async () => {
      process.env.RATE_LIMIT_API = '1'
      const ip = '203.0.7.9'

      expect((await request(app).head('/api/preview?path=/none.jpg').set('X-Forwarded-For', ip)).status).toBe(404)
      expect((await request(app).head('/api/preview/?path=/none.jpg').set('X-Forwarded-For', ip)).status).toBe(404)
      expect((await request(app).get('/api/list').set(from(ip))).status).toBe(200)
    })

    it('counts every spelling of a route together', async () => {
      process.env.RATE_LIMIT_SEARCH = '1'
      const ip = '203.0.5.1'

      expect((await request(app).get('/api/search?query=a').set(from(ip))).status).toBe(200)
      expect((await request(app).get('/api//search?query=a').set(from(ip))).status).toBe(429)
    })

    it('answers an address over the general limit before parsing its body', async () => {
      process.env.RATE_LIMIT_API = '1'
      const ip = '203.0.6.1'
      expect((await request(app).get('/api/list').set(from(ip))).status).toBe(200)

      const res = await request(app)
        .post('/api/mkdir')
        .set(from(ip))
        .set('Content-Type', 'application/json')
        .send('{bad')

      expect(res.status).toBe(429)
      expect(res.body).toEqual({ error: 'Too many requests', reason: 'rate_limited' })
    })
  })

  describe('a route that does not exist', () => {
    const key = { 'x-api-key': 'test-key' }

    it.each([
      ['get', '/api/nope'],
      ['post', '/api/nope'],
      ['get', '/api/list/extra'],
      ['get', '/api/trash/nope'],
      ['delete', '/api/settings'],
      ['post', '/api/preview'],
      ['get', '/api'],
      ['get', '/api/'],
      ['get', '/API/nope'],
    ] as const)('answers %s %s with a JSON 404', async (method, url) => {
      const res = await request(app)[method](url).set(key)

      expect(res.status).toBe(404)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.body).toEqual({ error: 'Not found' })
    })

    it('still asks for a key first', async () => {
      const res = await request(app).get('/api/nope')

      expect(res.status).toBe(401)
      expect(res.body).toEqual({ error: 'API key required' })
    })

    it('does not stand in front of a real route', async () => {
      expect((await request(app).get('/api/list').set(key)).status).toBe(200)
      expect((await request(app).get('/api/trash').set(key)).status).toBe(200)
      expect((await request(app).get('/api/stars').set(key)).status).toBe(200)
      expect((await request(app).get('/api/activity/summary').set(key)).status).toBe(200)
      expect((await request(app).get('/api/storage').set(key)).status).toBe(200)
      expect((await request(app).get('/api/settings').set(key)).status).toBe(200)
      expect((await request(app).get('/api/search?query=a').set(key)).status).toBe(200)
      expect((await request(app).post('/api/mkdir').set(key).send({ path: '/made' })).body).toEqual({ success: true })
      expect((await request(app).get('/health')).body).toEqual({ status: 'ok' })
      expect((await request(app).get('/files/page.html')).status).toBe(200)
      expect((await request(app).get('/uploads/page.html')).status).toBe(200)
    })

    it('leaves a path outside /api to the handler it had', async () => {
      const res = await request(app).get('/nope').set(key)

      expect(res.status).toBe(404)
      expect(res.body).not.toEqual({ error: 'Not found' })
    })
  })

  describe('client mistakes', () => {
    const key = { 'x-api-key': 'test-key' }
    let log: MockInstance

    beforeAll(async () => {
      await fs.mkdir(path.join(DIR, 'docs'), { recursive: true })
      await fs.mkdir(path.join(DIR, '.previews', 'docs'), { recursive: true })
      await fs.writeFile(path.join(DIR, '.previews', 'pic.jpg'), 'thumb')
    })

    beforeEach(() => {
      log = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
      log.mockRestore()
    })

    /** A JSON answer that tells nothing about the server and is not logged as its fault. */
    const expectRefused = (res: request.Response, status: number, body: object) => {
      expect(res.status).toBe(status)
      expect(res.body).toEqual(body)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(res.text).not.toContain(process.cwd())
      expect(log).not.toHaveBeenCalled()
    }

    it.each([
      ['mkdir', { path: 5 }],
      ['mkdir', { path: ['a'] }],
      ['mkdir', { path: { a: 1 } }],
      ['mkdir', { path: '/a\u0000b' }],
      ['delete', { paths: [5] }],
      ['delete', { paths: ['/a\u0000b'] }],
      ['rename', { oldPath: ['a'], newPath: '/b' }],
      ['rename', { oldPath: '/docs', newPath: { a: 1 } }],
      ['copy', { sources: [{ a: 1 }], destDir: '/' }],
    ])('answers 400 to /api/%s with %j', async (route, body) => {
      const res = await request(app).post(`/api/${route}`).set(key).send(body)

      expectRefused(res, 400, { error: 'Invalid path' })
    })

    it.each(['/api/list?path[]=a', '/api/list?path[a]=b', '/api/list?path=a%00b', '/api/preview?path[]=a', '/api/preview?path=a%00b'])(
      'answers 400 to GET %s',
      async url => {
        const res = await request(app).get(url).set(key)

        expectRefused(res, 400, { error: 'Invalid path' })
      },
    )

    it.each([
      ['a name too long for the disk', 'mkdir', { path: `/${'x'.repeat(300)}` }],
      ['a folder where a file is', 'mkdir', { path: '/page.html' }],
      ['a folder moved into itself', 'rename', { oldPath: '/docs', newPath: '/docs/inner' }],
      ['a folder copied into itself', 'copy', { sources: ['/docs'], destDir: '/docs' }],
    ])('answers 400 to %s', async (_what, route, body) => {
      const res = await request(app).post(`/api/${route}`).set(key).send(body)

      expectRefused(res, 400, { error: 'Invalid request' })
    })

    it('answers a range outside a public file as JSON, without the headers of the file', async () => {
      const res = await request(app).get('/files/page.html').set('Range', 'bytes=9999-')

      expectRefused(res, 416, { error: 'Invalid request' })
      expect(res.headers['content-disposition']).toBeUndefined()
      expect(res.headers['content-security-policy']).toBeUndefined()
    })

    it.each([
      ['a missing thumbnail', '/api/preview?path=/none.jpg', {}, 404, { error: 'Not found' }],
      ['a thumbnail below a file', '/api/preview?path=/pic.jpg/x', {}, 404, { error: 'Not found' }],
      ['a folder of thumbnails', '/api/preview?path=/docs', {}, 400, { error: 'Invalid request' }],
      ['a thumbnail name too long for the disk', `/api/preview?path=/${'x'.repeat(300)}.jpg`, {}, 400, { error: 'Invalid request' }],
      ['a range outside a thumbnail', '/api/preview?path=/pic.jpg', { Range: 'bytes=9999-' }, 416, { error: 'Invalid request' }],
    ])('answers a request for %s as JSON', async (_what, url, headers, status, body) => {
      const res = await request(app).get(url).set(headers)

      expectRefused(res, status, body)
    })

    it('still serves a thumbnail', async () => {
      const res = await request(app).get('/api/preview?path=/pic.jpg')

      expect(res.status).toBe(200)
      expect(res.headers['content-type']).toBe('image/jpeg')
      expect(res.body.toString()).toBe('thumb')
    })

    it.each([
      ['GET', '/api/search?query[]=a', undefined, 400],
      ['POST', '/api/activity', { path: '/docs', name: { a: 1 }, type: 'dir' }, 400],
      ['POST', '/api/activity', { path: 5, name: 'docs', type: 'dir' }, 400],
      ['POST', '/api/activity', { path: ['/docs'], name: 'docs', type: 'dir' }, 400],
      ['POST', '/api/activity', { path: { a: 1 }, name: 'docs', type: 'dir' }, 400],
      ['POST', '/api/activity', { path: '/docs', name: 5, type: 'dir' }, 400],
      ['POST', '/api/activity', { path: '/docs', name: ['docs'], type: 'dir' }, 400],
      ['POST', '/api/trash/restore', { id: ['a'] }, 404],
      ['POST', '/api/trash/delete', { id: { a: 1 } }, 404],
    ])('answers %s %s with %j as a client error', async (method, url, body, status) => {
      const res = method === 'GET' ? await request(app).get(url).set(key) : await request(app).post(url).set(key).send(body)

      expect(res.status).toBe(status)
      expect(res.headers['content-type']).toMatch(/^application\/json/)
      expect(log).not.toHaveBeenCalled()
    })
  })
})
