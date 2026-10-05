import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs/promises'
import path from 'path'
import { publicFiles } from './static-files'

const DIR = path.join(process.cwd(), 'temp', 'test-static')
const UNICODE_NAME = 'отчёт "1".html'

describe('public file serving', () => {
  let app: express.Application

  beforeAll(async () => {
    await fs.rm(DIR, { recursive: true, force: true })
    for (const dir of ['docs', '.trash/abc', '.previews', '.hidden']) {
      await fs.mkdir(path.join(DIR, dir), { recursive: true })
    }
    const files: Record<string, string> = {
      'page.html': '<script>1</script>',
      'PAGE.HTM': '<script>1</script>',
      'doc.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"/>',
      'pic.svg': '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>',
      'app.js': 'alert(1)',
      'mod.mjs': 'export {}',
      'data.xml': '<x/>',
      'feed.rss': '<rss/>',
      [UNICODE_NAME]: '<script>1</script>',
      'photo.jpg': 'jpeg',
      'note.txt': '<html><script>1</script>',
      'report.pdf': '%PDF-1.4',
      'docs/index.html': '<h1>index</h1>',
      '.trash/abc/secret.txt': 'trashed',
      '.previews/p.jpg': 'preview',
      '.hidden/a.txt': 'hidden',
      '.env': 'SECRET=1',
    }
    for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(DIR, name), body)

    app = express()
    app.use('/files', publicFiles(DIR))
  })

  afterAll(async () => {
    await fs.rm(DIR, { recursive: true, force: true })
  })

  it.each(['page.html', 'PAGE.HTM', 'doc.xhtml', 'pic.svg', 'app.js', 'mod.mjs', 'data.xml', 'feed.rss'])(
    'sends %s as a download that cannot run in the page',
    async name => {
      const res = await request(app).get(`/files/${name}`)

      expect(res.status).toBe(200)
      expect(res.headers['content-disposition']).toBe(`attachment; filename="${name}"; filename*=UTF-8''${name}`)
      expect(res.headers['x-content-type-options']).toBe('nosniff')
      expect(res.headers['content-security-policy']).toBe("sandbox; default-src 'none'")
    },
  )

  it('keeps the real content type on a download, so <img> and <script> still work', async () => {
    expect((await request(app).get('/files/pic.svg')).headers['content-type']).toMatch(/^image\/svg\+xml/)
    expect((await request(app).get('/files/app.js')).headers['content-type']).toMatch(/javascript/)
    expect((await request(app).get('/files/page.html')).headers['content-type']).toMatch(/^text\/html/)
  })

  it('names a download with a non-ASCII name safely', async () => {
    const res = await request(app).get('/files/' + encodeURIComponent(UNICODE_NAME))

    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="_____ _1_.html"; filename*=UTF-8''%D0%BE%D1%82%D1%87%D1%91%D1%82%20%221%22.html`,
    )
  })

  it.each(['photo.jpg', 'note.txt', 'report.pdf'])('serves %s inline, with nosniff and no sandbox', async name => {
    const res = await request(app).get(`/files/${name}`)

    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBeUndefined()
    expect(res.headers['content-security-policy']).toBeUndefined()
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })

  it('does not serve index.html for a folder, and does not redirect to it', async () => {
    expect((await request(app).get('/files/docs/')).status).toBe(404)
    expect((await request(app).get('/files/docs')).status).toBe(404)
  })

  it.each(['.trash/abc/secret.txt', '.previews/p.jpg', '.hidden/a.txt', '.env'])('hides the dot path %s', async name => {
    const res = await request(app).get(`/files/${name}`)

    expect(res.status).toBe(404)
    expect(res.text).not.toContain('trashed')
  })

  it('stays inside the uploads folder', async () => {
    expect((await request(app).get('/files/..%2f..%2fpackage.json')).status).toBe(404)
  })
})
