import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import express from 'express'
import request from 'supertest'
import { trashRouter, resetTrashStore, getTrashStore, stashLegacyTrashPreviews } from './trash'
import { filesRouter, resetStorage } from './files'
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
    // For GET /api/preview: the thumbnail tests ask what a visitor can still fetch. First, as in
    // app.ts: the preview route has to come before any router's API-key check.
    app.use('/api', filesRouter)
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

    // Removed by hand, or by a delete that stopped half-way: the row could never be deleted.
    it('deletes a row whose trash folder is already missing', async () => {
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'gone.txt'), 'bye')
      await request(app).post('/api/trash/move').set('x-api-key', 'test-key').send({ paths: ['/gone.txt'] })
      const [{ id }] = getTrashStore().all()
      await fs.rm(path.join(TEST_UPLOADS_DIR, '.trash', id), { recursive: true })

      const res = await request(app).post('/api/trash/delete').set('x-api-key', 'test-key').send({ id })

      expect(res.status).toBe(200)
      expect(res.body).toEqual({ deleted: true })
      expect(getTrashStore().all()).toEqual([])
      // And then it is gone, as any other deleted item.
      expect((await request(app).post('/api/trash/delete').set('x-api-key', 'test-key').send({ id })).status).toBe(404)
    })

    it('deletes a row when the whole .trash folder is missing', async () => {
      getTrashStore().add('no-trash', '/gone.txt', 'gone.txt', 'file')

      const res = await request(app).post('/api/trash/delete').set('x-api-key', 'test-key').send({ id: 'no-trash' })

      expect(res.status).toBe(200)
      expect(getTrashStore().all()).toEqual([])
    })

    it('returns 401 without auth', async () => {
      const res = await request(app).post('/api/trash/delete').send({ id: 'x' })
      expect(res.status).toBe(401)
    })
  })

  describe('thumbnails', () => {
    const PREVIEWS = path.join(TEST_UPLOADS_DIR, '.previews')
    const key = { 'x-api-key': 'test-key' }

    const writeWithPreview = async (relativePath: string, thumb: string) => {
      await fs.mkdir(path.dirname(path.join(TEST_UPLOADS_DIR, relativePath)), { recursive: true })
      await fs.mkdir(path.dirname(path.join(PREVIEWS, relativePath)), { recursive: true })
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, relativePath), 'image')
      await fs.writeFile(path.join(PREVIEWS, relativePath), thumb)
    }
    const preview = (virtualPath: string) => request(app).get(`/api/preview?path=${encodeURIComponent(virtualPath)}`)
    const moveToTrash = async (virtualPath: string): Promise<string> => {
      const moved = await request(app).post('/api/trash/move').set(key).send({ paths: [virtualPath] })
      expect(moved.body).toEqual({ moved: 1 })
      const list = await request(app).get('/api/trash').set(key)
      return list.body.files[0].trashId
    }
    const filesUnder = async (dir: string): Promise<string[]> => {
      const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
      return entries.filter(entry => entry.isFile()).map(entry => entry.name)
    }

    it('stops serving the thumbnail of a trashed file', async () => {
      await writeWithPreview('img.jpg', 'thumb')
      expect((await preview('/img.jpg')).status).toBe(200)

      const id = await moveToTrash('/img.jpg')

      expect((await preview('/img.jpg')).status).toBe(404)
      expect(await filesUnder(PREVIEWS)).toEqual([])
      // Kept with the item, for a restore.
      expect(await fs.readFile(path.join(TEST_UPLOADS_DIR, '.trash', id, '.preview'), 'utf-8')).toBe('thumb')
    })

    it('stops serving the thumbnails of a trashed folder', async () => {
      await writeWithPreview('album/inner/img.jpg', 'thumb')
      await writeWithPreview('other.jpg', 'other')
      expect((await preview('/album/inner/img.jpg')).status).toBe(200)

      await moveToTrash('/album')

      expect((await preview('/album/inner/img.jpg')).status).toBe(404)
      await expect(fs.access(path.join(PREVIEWS, 'album'))).rejects.toThrow()
      expect((await preview('/other.jpg')).status).toBe(200)
    })

    it('lists trashed items without a preview URL', async () => {
      await writeWithPreview('img.jpg', 'thumb')
      await moveToTrash('/img.jpg')

      const list = await request(app).get('/api/trash').set(key)

      expect(list.body.files).toHaveLength(1)
      expect(list.body.files[0]).not.toHaveProperty('preview')
    })

    it('serves the thumbnail again after a restore', async () => {
      await writeWithPreview('photos/img.jpg', 'thumb')
      const id = await moveToTrash('/photos/img.jpg')

      const restored = await request(app).post('/api/trash/restore').set(key).send({ id })

      expect(restored.body).toEqual({ path: '/photos/img.jpg' })
      const res = await preview('/photos/img.jpg')
      expect(res.status).toBe(200)
      expect(res.body.toString()).toBe('thumb')
    })

    it('serves the thumbnails of a restored folder again', async () => {
      await writeWithPreview('album/inner/img.jpg', 'thumb')
      const id = await moveToTrash('/album')

      await request(app).post('/api/trash/restore').set(key).send({ id }).expect(200)

      const res = await preview('/album/inner/img.jpg')
      expect(res.status).toBe(200)
      expect(res.body.toString()).toBe('thumb')
    })

    it('restores the thumbnail under the new name when the old one is taken', async () => {
      await writeWithPreview('img.jpg', 'old thumb')
      const id = await moveToTrash('/img.jpg')
      await writeWithPreview('img.jpg', 'new thumb')

      const restored = await request(app).post('/api/trash/restore').set(key).send({ id })

      expect(restored.body).toEqual({ path: '/img (2).jpg' })
      expect((await preview('/img (2).jpg')).body.toString()).toBe('old thumb')
      expect((await preview('/img.jpg')).body.toString()).toBe('new thumb')
    })

    it.each([['file', 'img.jpg', '/img.jpg'], ['folder', 'album/img.jpg', '/album']])(
      'leaves no thumbnail behind when a trashed %s is deleted for good',
      async (_kind, file, trashed) => {
        await writeWithPreview(file, 'thumb')
        const id = await moveToTrash(trashed)

        await request(app).post('/api/trash/delete').set(key).send({ id }).expect(200)

        expect(await filesUnder(PREVIEWS)).toEqual([])
        expect(await filesUnder(path.join(TEST_UPLOADS_DIR, '.trash'))).toEqual([])
        expect((await preview(`/${file}`)).status).toBe(404)
      },
    )

    it('keeps the thumbnail of a newer file with the same path when the trashed one is deleted', async () => {
      await writeWithPreview('img.jpg', 'old thumb')
      const id = await moveToTrash('/img.jpg')
      await writeWithPreview('img.jpg', 'new thumb')

      await request(app).post('/api/trash/delete').set(key).send({ id }).expect(200)

      expect((await preview('/img.jpg')).body.toString()).toBe('new thumb')
    })

    // On a disk that ignores case (macOS, Windows) `.PREVIEW` and the stash `.preview` are one path:
    // stashing the thumbnails would replace the trashed folder with them.
    it.each(['.PREVIEW', '.Preview', '.\uFF50review'])('does not replace a trashed folder named %s with its thumbnails', async name => {
      await writeWithPreview(`${name}/img.jpg`, 'thumb')
      const id = await moveToTrash(`/${name}`)

      expect((await preview(`/${name}/img.jpg`)).status).toBe(404)
      expect(await fs.readFile(path.join(TEST_UPLOADS_DIR, '.trash', id, name, 'img.jpg'), 'utf-8')).toBe('image')
      await request(app).post('/api/trash/restore').set(key).send({ id }).expect(200)

      expect(await fs.readFile(path.join(TEST_UPLOADS_DIR, name, 'img.jpg'), 'utf-8')).toBe('image')
      expect(await filesUnder(path.join(TEST_UPLOADS_DIR, '.trash'))).toEqual([])
    })

    it('does not replace a trashed file named .PREVIEW with its thumbnail', async () => {
      await writeWithPreview('.PREVIEW', 'thumb')
      const id = await moveToTrash('/.PREVIEW')

      expect((await preview('/.PREVIEW')).status).toBe(404)
      await request(app).post('/api/trash/restore').set(key).send({ id }).expect(200)

      expect(await fs.readFile(path.join(TEST_UPLOADS_DIR, '.PREVIEW'), 'utf-8')).toBe('image')
    })

    it('does not mix up a trashed folder named .preview with its thumbnails', async () => {
      await writeWithPreview('.preview/img.jpg', 'thumb')
      const id = await moveToTrash('/.preview')

      expect((await preview('/.preview/img.jpg')).status).toBe(404)
      await request(app).post('/api/trash/restore').set(key).send({ id }).expect(200)

      expect(await fs.readFile(path.join(TEST_UPLOADS_DIR, '.preview', 'img.jpg'), 'utf-8')).toBe('image')
    })
  })

  // Older versions left a trashed item's thumbnail in .previews, where /api/preview serves it.
  describe('thumbnails of items trashed by an older version', () => {
    const PREVIEWS = path.join(TEST_UPLOADS_DIR, '.previews')
    const TRASH = path.join(TEST_UPLOADS_DIR, '.trash')
    const key = { 'x-api-key': 'test-key' }

    const preview = (virtualPath: string) => request(app).get(`/api/preview?path=${encodeURIComponent(virtualPath)}`)
    const write = async (file: string, content: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, content)
    }
    /** As an older version left it: the item in its trash folder, its thumbnail where it was. */
    const legacyFile = async (id: string, originalPath: string, thumb: string) => {
      const name = path.basename(originalPath)
      await write(path.join(TRASH, id, name), 'image')
      await write(path.join(PREVIEWS, originalPath), thumb)
      getTrashStore().add(id, originalPath, name, 'file')
    }
    const legacyFolder = async (id: string, originalPath: string, inner: string, thumb: string) => {
      const name = path.basename(originalPath)
      await write(path.join(TRASH, id, name, inner), 'image')
      await write(path.join(PREVIEWS, originalPath, inner), thumb)
      getTrashStore().add(id, originalPath, name, 'dir')
    }
    const filesUnder = async (dir: string): Promise<string[]> => {
      const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])
      return entries.filter(entry => entry.isFile()).map(entry => entry.name)
    }

    describe('stashLegacyTrashPreviews', () => {
      it('hides the thumbnail of a trashed file and keeps it for a restore', async () => {
        await legacyFile('old-file', '/photos/img.jpg', 'thumb')
        expect((await preview('/photos/img.jpg')).status).toBe(200)

        await stashLegacyTrashPreviews()

        expect((await preview('/photos/img.jpg')).status).toBe(404)
        expect(await filesUnder(PREVIEWS)).toEqual([])
        expect(await fs.readFile(path.join(TRASH, 'old-file', '.preview'), 'utf-8')).toBe('thumb')

        const restored = await request(app).post('/api/trash/restore').set(key).send({ id: 'old-file' })

        expect(restored.body).toEqual({ path: '/photos/img.jpg' })
        const res = await preview('/photos/img.jpg')
        expect(res.status).toBe(200)
        expect(res.body.toString()).toBe('thumb')
      })

      it('hides the thumbnails of a trashed folder and keeps them for a restore', async () => {
        await legacyFolder('old-folder', '/album', 'inner/img.jpg', 'thumb')
        await write(path.join(PREVIEWS, 'other.jpg'), 'other')
        expect((await preview('/album/inner/img.jpg')).status).toBe(200)

        await stashLegacyTrashPreviews()

        expect((await preview('/album/inner/img.jpg')).status).toBe(404)
        await expect(fs.access(path.join(PREVIEWS, 'album'))).rejects.toThrow()
        expect(await fs.readFile(path.join(TRASH, 'old-folder', '.preview', 'inner', 'img.jpg'), 'utf-8')).toBe('thumb')
        // Only its own.
        expect((await preview('/other.jpg')).status).toBe(200)

        await request(app).post('/api/trash/restore').set(key).send({ id: 'old-folder' }).expect(200)

        const res = await preview('/album/inner/img.jpg')
        expect(res.status).toBe(200)
        expect(res.body.toString()).toBe('thumb')
      })

      it('leaves the thumbnail of a newer file uploaded to the same path', async () => {
        await legacyFile('old-file', '/img.jpg', 'new thumb')
        await write(path.join(TEST_UPLOADS_DIR, 'img.jpg'), 'new image')

        await stashLegacyTrashPreviews()

        const res = await preview('/img.jpg')
        expect(res.status).toBe(200)
        expect(res.body.toString()).toBe('new thumb')
        expect(await fs.readdir(path.join(TRASH, 'old-file'))).toEqual(['img.jpg'])
      })

      it('leaves the thumbnails of a newer folder created at the same path', async () => {
        await legacyFolder('old-folder', '/album', 'img.jpg', 'new thumb')
        await write(path.join(TEST_UPLOADS_DIR, 'album', 'img.jpg'), 'new image')

        await stashLegacyTrashPreviews()

        expect((await preview('/album/img.jpg')).body.toString()).toBe('new thumb')
        expect(await fs.readdir(path.join(TRASH, 'old-folder'))).toEqual(['album'])
      })

      it('changes nothing when it runs again', async () => {
        await legacyFile('old-file', '/img.jpg', 'thumb')
        await legacyFolder('old-folder', '/album', 'inner/img.jpg', 'thumb')

        expect(await stashLegacyTrashPreviews()).toBe(2)
        // Not the item's: a stash that is there is never replaced.
        await write(path.join(PREVIEWS, 'img.jpg'), 'another thumb')
        expect(await stashLegacyTrashPreviews()).toBe(0)

        expect(await fs.readFile(path.join(TRASH, 'old-file', '.preview'), 'utf-8')).toBe('thumb')
        expect(await fs.readFile(path.join(TRASH, 'old-folder', '.preview', 'inner', 'img.jpg'), 'utf-8')).toBe('thumb')
        expect((await preview('/img.jpg')).body.toString()).toBe('another thumb')
        expect((await preview('/album/inner/img.jpg')).status).toBe(404)
      })

      it('leaves an item trashed by this version alone', async () => {
        await write(path.join(TEST_UPLOADS_DIR, 'img.jpg'), 'image')
        await write(path.join(PREVIEWS, 'img.jpg'), 'thumb')
        await request(app).post('/api/trash/move').set(key).send({ paths: ['/img.jpg'] }).expect(200)
        const [{ id }] = getTrashStore().all()

        expect(await stashLegacyTrashPreviews()).toBe(0)

        expect(await fs.readFile(path.join(TRASH, id, '.preview'), 'utf-8')).toBe('thumb')
      })

      it('skips a row whose trash folder is missing', async () => {
        await write(path.join(PREVIEWS, 'img.jpg'), 'thumb')
        getTrashStore().add('no-folder', '/img.jpg', 'img.jpg', 'file')

        await expect(stashLegacyTrashPreviews()).resolves.toBe(0)

        expect((await preview('/img.jpg')).status).toBe(200)
        // Not created for it either.
        expect(await fs.readdir(TEST_UPLOADS_DIR)).toEqual(['.previews'])
      })

      it.each(['/../img.jpg', '/a/../../img.jpg', '/.previews/img.jpg', '/', ''])(
        'skips a row whose stored path is %j',
        async storedPath => {
          await write(path.join(TRASH, 'bad-path', 'img.jpg'), 'image')
          await write(path.join(PREVIEWS, 'img.jpg'), 'thumb')
          await write(path.join(PREVIEWS, '.previews', 'img.jpg'), 'thumb')
          // Where `.previews/../img.jpg` points.
          await write(path.join(TEST_UPLOADS_DIR, 'img.jpg'), 'image')
          getTrashStore().add('bad-path', storedPath, 'img.jpg', 'file')

          await expect(stashLegacyTrashPreviews()).resolves.toBe(0)

          expect(await fs.readdir(path.join(TRASH, 'bad-path'))).toEqual(['img.jpg'])
          expect((await filesUnder(PREVIEWS)).sort()).toEqual(['img.jpg', 'img.jpg'])
          expect(await fs.readFile(path.join(TEST_UPLOADS_DIR, 'img.jpg'), 'utf-8')).toBe('image')
        },
      )

      it('goes on to the other rows after one it cannot use', async () => {
        getTrashStore().add('no-folder', '/gone.jpg', 'gone.jpg', 'file')
        await write(path.join(TRASH, 'bad-path', 'x.jpg'), 'image')
        getTrashStore().add('bad-path', '/../x.jpg', 'x.jpg', 'file')
        await legacyFile('old-file', '/img.jpg', 'thumb')

        await expect(stashLegacyTrashPreviews()).resolves.toBe(1)

        expect((await preview('/img.jpg')).status).toBe(404)
        expect(await fs.readFile(path.join(TRASH, 'old-file', '.preview'), 'utf-8')).toBe('thumb')
      })

      it('creates no .previews or .trash folder', async () => {
        getTrashStore().add('no-folder', '/img.jpg', 'img.jpg', 'file')

        await expect(stashLegacyTrashPreviews()).resolves.toBe(0)

        expect(await fs.readdir(TEST_UPLOADS_DIR)).toEqual([])
      })

      it('does nothing for an empty trash', async () => {
        await expect(stashLegacyTrashPreviews()).resolves.toBe(0)

        expect(await fs.readdir(TEST_UPLOADS_DIR)).toEqual([])
      })

      it('gives a file trashed before its folder its own thumbnail', async () => {
        await legacyFile('old-file', '/album/img.jpg', 'thumb')
        await legacyFolder('old-folder', '/album', 'kept.jpg', 'kept thumb')

        await stashLegacyTrashPreviews()
        await request(app).post('/api/trash/restore').set(key).send({ id: 'old-folder' }).expect(200)

        // Back with the folder, a visitor could fetch the thumbnail of a file that is still trashed.
        expect((await preview('/album/kept.jpg')).status).toBe(200)
        expect((await preview('/album/img.jpg')).status).toBe(404)
        expect(await fs.readFile(path.join(TRASH, 'old-file', '.preview'), 'utf-8')).toBe('thumb')
      })

      it('removes the thumbnails of a trashed folder named like the stash in other letters', async () => {
        await legacyFolder('old-folder', '/.PREVIEW', 'img.jpg', 'thumb')

        await stashLegacyTrashPreviews()

        expect((await preview('/.PREVIEW/img.jpg')).status).toBe(404)
        expect(await fs.readFile(path.join(TRASH, 'old-folder', '.PREVIEW', 'img.jpg'), 'utf-8')).toBe('image')
      })

      it('removes the thumbnails of a trashed folder named like the stash', async () => {
        await legacyFolder('old-folder', '/.preview', 'img.jpg', 'thumb')

        await stashLegacyTrashPreviews()

        expect((await preview('/.preview/img.jpg')).status).toBe(404)
        expect(await fs.readFile(path.join(TRASH, 'old-folder', '.preview', 'img.jpg'), 'utf-8')).toBe('image')
      })
    })

    // What the startup pass did not reach.
    describe('POST /api/trash/delete', () => {
      it('removes the thumbnail of a file', async () => {
        await legacyFile('old-file', '/photos/img.jpg', 'thumb')

        await request(app).post('/api/trash/delete').set(key).send({ id: 'old-file' }).expect(200)

        expect((await preview('/photos/img.jpg')).status).toBe(404)
        expect(await filesUnder(PREVIEWS)).toEqual([])
        expect(await filesUnder(TRASH)).toEqual([])
      })

      it('removes the thumbnails of a folder', async () => {
        await legacyFolder('old-folder', '/album', 'inner/img.jpg', 'thumb')
        await write(path.join(PREVIEWS, 'other.jpg'), 'other')

        await request(app).post('/api/trash/delete').set(key).send({ id: 'old-folder' }).expect(200)

        expect((await preview('/album/inner/img.jpg')).status).toBe(404)
        await expect(fs.access(path.join(PREVIEWS, 'album'))).rejects.toThrow()
        expect((await preview('/other.jpg')).status).toBe(200)
      })

      it('leaves the thumbnail of a newer file uploaded to the same path', async () => {
        await legacyFile('old-file', '/img.jpg', 'new thumb')
        await write(path.join(TEST_UPLOADS_DIR, 'img.jpg'), 'new image')

        await request(app).post('/api/trash/delete').set(key).send({ id: 'old-file' }).expect(200)

        const res = await preview('/img.jpg')
        expect(res.status).toBe(200)
        expect(res.body.toString()).toBe('new thumb')
      })

      it('leaves the thumbnails of a newer folder created at the same path', async () => {
        await legacyFolder('old-folder', '/album', 'img.jpg', 'new thumb')
        await write(path.join(TEST_UPLOADS_DIR, 'album', 'img.jpg'), 'new image')

        await request(app).post('/api/trash/delete').set(key).send({ id: 'old-folder' }).expect(200)

        expect((await preview('/album/img.jpg')).body.toString()).toBe('new thumb')
      })

      it('still deletes an item whose stored path is not a valid one', async () => {
        await write(path.join(TRASH, 'bad-path', 'img.jpg'), 'image')
        await write(path.join(TEST_UPLOADS_DIR, 'keep.jpg'), 'image')
        getTrashStore().add('bad-path', '/../keep.jpg', 'img.jpg', 'file')

        await request(app).post('/api/trash/delete').set(key).send({ id: 'bad-path' }).expect(200)

        expect(await fs.readFile(path.join(TEST_UPLOADS_DIR, 'keep.jpg'), 'utf-8')).toBe('image')
        expect(getTrashStore().all()).toEqual([])
      })
    })
  })

  describe('item names', () => {
    const key = { 'x-api-key': 'test-key' }

    it('names a trashed item by what the path resolves to, not by how it was written', async () => {
      await fs.mkdir(path.join(TEST_UPLOADS_DIR, 'a', 'b'), { recursive: true })

      const moved = await request(app).post('/api/trash/move').set(key).send({ paths: ['/a/b/..'] })
      const list = await request(app).get('/api/trash').set(key)

      expect(moved.body).toEqual({ moved: 1 })
      expect(list.body.files[0]).toMatchObject({ name: 'a', path: '/a', type: 'dir' })

      const restored = await request(app).post('/api/trash/restore').set(key).send({ id: list.body.files[0].trashId })

      expect(restored.status).toBe(200)
      expect(restored.body).toEqual({ path: '/a' })
      await expect(fs.access(path.join(TEST_UPLOADS_DIR, 'a', 'b'))).resolves.toBeUndefined()
      expect((await fs.readdir(TEST_UPLOADS_DIR)).sort()).toEqual(['.trash', 'a'])
    })

    it.each(['/a/..', 'a/b/../..', '.', './', ''])('does not move %j, which resolves to the storage root', async root => {
      await fs.mkdir(path.join(TEST_UPLOADS_DIR, 'a', 'b'), { recursive: true })

      const moved = await request(app).post('/api/trash/move').set(key).send({ paths: [root] })

      expect(moved.body).toEqual({ moved: 0 })
      await expect(fs.access(path.join(TEST_UPLOADS_DIR, 'a', 'b'))).resolves.toBeUndefined()
      expect((await request(app).get('/api/trash').set(key)).body.total).toBe(0)
    })

    // Rows written by older versions may hold such names.
    it.each(['..', '.', '', 'x/y', 'x\\y'])('refuses to restore an item whose stored name is %j', async name => {
      const id = 'legacy-item'
      await fs.mkdir(path.join(TEST_UPLOADS_DIR, '.trash', id, 'x'), { recursive: true })
      await fs.writeFile(path.join(TEST_UPLOADS_DIR, '.trash', id, 'x', 'y'), 'kept')
      await fs.mkdir(path.join(TEST_UPLOADS_DIR, 'a'))
      getTrashStore().add(id, '/a/b/..', name, 'dir')

      const res = await request(app).post('/api/trash/restore').set(key).send({ id })

      expect(res.status).toBe(400)
      expect(res.body).toEqual({ error: 'Invalid trash item' })
      expect(await fs.readFile(path.join(TEST_UPLOADS_DIR, '.trash', id, 'x', 'y'), 'utf-8')).toBe('kept')
      expect((await fs.readdir(TEST_UPLOADS_DIR)).sort()).toEqual(['.trash', 'a'])
      expect((await request(app).get('/api/trash').set(key)).body.total).toBe(1)
    })
  })

  it('does not move the storage root or an internal folder to the trash', async () => {
    await fs.writeFile(path.join(TEST_UPLOADS_DIR, 'keep.txt'), 'x')
    // Must exist, or the move fails for the wrong reason and the test proves nothing.
    await fs.mkdir(path.join(TEST_UPLOADS_DIR, '.previews'), { recursive: true })

    const res = await request(app)
      .post('/api/trash/move')
      .set('x-api-key', 'test-key')
      .send({ paths: ['/', '/.trash', '/.previews'] })

    expect(res.body).toEqual({ moved: 0 })
    await expect(fs.access(path.join(TEST_UPLOADS_DIR, 'keep.txt'))).resolves.toBeUndefined()
    await expect(fs.access(path.join(TEST_UPLOADS_DIR, '.previews'))).resolves.toBeUndefined()
  })
})
