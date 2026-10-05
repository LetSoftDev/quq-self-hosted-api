import { describe, it, expect, beforeEach, afterEach, afterAll, vi, type MockInstance } from 'vitest'
import express from 'express'
import request from 'supertest'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import { tidyPreviews } from './startup'
import { filesRouter, resetStorage } from './routes/files'
import { trashRouter, getTrashStore, resetTrashStore } from './routes/trash'

const UPLOADS = path.join(process.cwd(), 'temp', 'test-startup-uploads')
const DATA = path.join(process.cwd(), 'temp', 'test-startup-data')
const PREVIEWS = path.join(UPLOADS, '.previews')
const TRASH = path.join(UPLOADS, '.trash')

// What a server that was updated from an older version finds on its disk when it starts.
describe('tidyPreviews', () => {
  let app: express.Application
  let log: MockInstance
  const key = { 'x-api-key': 'test-key' }

  beforeEach(async () => {
    await fs.rm(UPLOADS, { recursive: true, force: true })
    await fs.rm(DATA, { recursive: true, force: true })
    await fs.mkdir(UPLOADS, { recursive: true })
    await fs.mkdir(DATA, { recursive: true })
    process.env.UPLOADS_DIR = UPLOADS
    process.env.DATA_DIR = DATA
    resetStorage()
    resetTrashStore()
    app = express()
    app.use(express.json())
    app.use('/api', filesRouter)
    app.use('/api', trashRouter)
    log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    log.mockRestore()
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await fs.rm(UPLOADS, { recursive: true, force: true })
    await fs.rm(DATA, { recursive: true, force: true })
  })

  const write = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
  const live = (relativePath: string) => write(path.join(UPLOADS, relativePath), 'image')
  const thumb = (relativePath: string, content = 'thumb') => write(path.join(PREVIEWS, relativePath), content)
  const preview = (virtualPath: string) => request(app).get(`/api/preview?path=${encodeURIComponent(virtualPath)}`)
  const filesUnder = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
    return entries
      .filter(entry => entry.isFile())
      .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort()
  }

  it('removes the thumbnails of a folder that an older version deleted without them', async () => {
    await thumb('album/a.jpg')
    await thumb('album/deep/b.jpg')
    await live('kept.jpg')
    await thumb('kept.jpg')
    expect((await preview('/album/a.jpg')).status).toBe(200)

    await tidyPreviews()

    expect((await preview('/album/a.jpg')).status).toBe(404)
    expect((await preview('/album/deep/b.jpg')).status).toBe(404)
    expect((await preview('/kept.jpg')).status).toBe(200)
    expect(await fs.readdir(PREVIEWS)).toEqual(['kept.jpg'])
  })

  it('removes the thumbnails of a trashed folder whose path a live folder has taken', async () => {
    // Trashed by an older version: its thumbnails stayed in .previews.
    await write(path.join(TRASH, 'old-folder', 'album', 'trashed.jpg'), 'image')
    await thumb('album/trashed.jpg')
    getTrashStore().add('old-folder', '/album', 'album', 'dir')
    // Then a new folder was made at the same path.
    await live('album/new.jpg')
    await thumb('album/new.jpg', 'new thumb')

    await tidyPreviews()

    expect((await preview('/album/trashed.jpg')).status).toBe(404)
    expect((await preview('/album/new.jpg')).body.toString()).toBe('new thumb')
    expect(await filesUnder(PREVIEWS)).toEqual(['album/new.jpg'])
    // The trashed folder itself is as it was, and can still be restored.
    expect(await filesUnder(TRASH)).toEqual(['old-folder/album/trashed.jpg'])
  })

  it('removes the thumbnail of a trash row whose folder is missing', async () => {
    await thumb('img.jpg')
    await thumb('album/inner.jpg')
    getTrashStore().add('no-folder', '/img.jpg', 'img.jpg', 'file')
    getTrashStore().add('no-folder-dir', '/album', 'album', 'dir')

    await tidyPreviews()

    expect((await preview('/img.jpg')).status).toBe(404)
    expect((await preview('/album/inner.jpg')).status).toBe(404)
    expect(await filesUnder(UPLOADS)).toEqual([])
  })

  it('stashes the thumbnail of an item trashed by an older version before it looks for orphans', async () => {
    await write(path.join(TRASH, 'old-file', 'img.jpg'), 'image')
    await thumb('photos/img.jpg')
    getTrashStore().add('old-file', '/photos/img.jpg', 'img.jpg', 'file')

    await tidyPreviews()

    expect((await preview('/photos/img.jpg')).status).toBe(404)
    // Kept for a restore, not lost as an orphan.
    expect(await fs.readFile(path.join(TRASH, 'old-file', '.preview'), 'utf-8')).toBe('thumb')
    await request(app).post('/api/trash/restore').set(key).send({ id: 'old-file' }).expect(200)
    expect((await preview('/photos/img.jpg')).status).toBe(200)
  })

  it('changes nothing when it runs again', async () => {
    await write(path.join(TRASH, 'old-file', 'img.jpg'), 'image')
    await thumb('photos/img.jpg')
    getTrashStore().add('old-file', '/photos/img.jpg', 'img.jpg', 'file')
    await thumb('gone/a.jpg')
    await live('kept.jpg')
    await thumb('kept.jpg')
    await tidyPreviews()
    const after = await filesUnder(UPLOADS)

    await tidyPreviews()

    expect(await filesUnder(UPLOADS)).toEqual(after)
    expect(after).toEqual(['.previews/kept.jpg', '.trash/old-file/.preview', '.trash/old-file/img.jpg', 'kept.jpg'])
  })

  it('still removes the orphans when the trash cannot be read, and does not reject', async () => {
    await thumb('gone.jpg')
    vi.spyOn(getTrashStore(), 'all').mockImplementation(() => {
      throw new Error('database is locked')
    })

    await expect(tidyPreviews()).resolves.toBeUndefined()

    expect((await preview('/gone.jpg')).status).toBe(404)
    expect(log).toHaveBeenCalled()
  })

  // On a large store the check takes a while, and the server does not listen until it is done.
  it('logs one line before it starts', async () => {
    await thumb('gone.jpg')
    const stillThere: boolean[] = []
    const info = vi.spyOn(console, 'log').mockImplementation(() => {
      stillThere.push(existsSync(path.join(PREVIEWS, 'gone.jpg')))
    })

    await tidyPreviews()

    expect(info.mock.calls[0]).toEqual(['[thumbnail] Checking previews…'])
    expect(stillThere[0]).toBe(true)
    expect(existsSync(path.join(PREVIEWS, 'gone.jpg'))).toBe(false)
  })

  it('does not reject when the sweep itself fails', async () => {
    await thumb('gone.jpg')
    vi.spyOn(fs, 'lstat').mockRejectedValue(new Error('disk on fire'))

    await expect(tidyPreviews()).resolves.toBeUndefined()
  })
})
