import { describe, it, expect, beforeEach, afterEach, afterAll, vi, type MockInstance } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { removeOrphanPreviews } from './orphan-previews'

const ROOT = path.join(process.cwd(), 'temp', 'test-orphan-previews')
const UPLOADS = path.join(ROOT, 'uploads')
const PREVIEWS = path.join(UPLOADS, '.previews')
const OUTSIDE = path.join(ROOT, 'outside')

describe('removeOrphanPreviews', () => {
  let log: MockInstance

  beforeEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true })
    await fs.mkdir(UPLOADS, { recursive: true })
    process.env.UPLOADS_DIR = UPLOADS
    log = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    log.mockRestore()
  })

  afterAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true })
  })

  const write = async (file: string, content = 'x') => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content)
  }
  const live = (relativePath: string) => write(path.join(UPLOADS, relativePath), 'image')
  const thumb = (relativePath: string) => write(path.join(PREVIEWS, relativePath), 'thumb')
  /** Every file and folder under `dir`, relative to it, with '/' between the segments. */
  const tree = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true })
    return entries
      .map(entry => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .sort()
  }

  it('removes the thumbnails of a folder that was deleted without them, and the folders they were in', async () => {
    await thumb('album/a.jpg')
    await thumb('album/deep/b.jpg')
    await thumb('gone.jpg')

    await expect(removeOrphanPreviews()).resolves.toBe(3)

    expect(await tree(PREVIEWS)).toEqual([])
  })

  it('keeps the thumbnail of a live file', async () => {
    await live('img.jpg')
    await thumb('img.jpg')
    await live('album/deep/b.jpg')
    await thumb('album/deep/b.jpg')

    await expect(removeOrphanPreviews()).resolves.toBe(0)

    expect(await tree(PREVIEWS)).toEqual(['album', 'album/deep', 'album/deep/b.jpg', 'img.jpg'])
    expect(await fs.readFile(path.join(PREVIEWS, 'img.jpg'), 'utf-8')).toBe('thumb')
  })

  it('tells live files from gone ones in the same nested folders', async () => {
    await live('a/keep.jpg')
    await thumb('a/keep.jpg')
    await thumb('a/gone.jpg')
    await live('a/b/c/keep.jpg')
    await thumb('a/b/c/keep.jpg')
    await thumb('a/b/c/gone.jpg')
    await thumb('a/b/empty-after/gone.jpg')
    await live('a/no-thumbnail.txt')

    await expect(removeOrphanPreviews()).resolves.toBe(3)

    expect(await tree(PREVIEWS)).toEqual(['a', 'a/b', 'a/b/c', 'a/b/c/keep.jpg', 'a/keep.jpg'])
  })

  it('removes folders that were already empty, but not .previews itself', async () => {
    await fs.mkdir(path.join(PREVIEWS, 'empty', 'inner'), { recursive: true })

    await expect(removeOrphanPreviews()).resolves.toBe(0)

    expect(await fs.readdir(UPLOADS)).toEqual(['.previews'])
    expect(await tree(PREVIEWS)).toEqual([])
  })

  it('removes a thumbnail whose path is now a folder, and the thumbnails below what is now a file', async () => {
    await live('now-a-folder.jpg/inner.txt')
    await thumb('now-a-folder.jpg')
    await live('now-a-file')
    await thumb('now-a-file/img.jpg')

    await expect(removeOrphanPreviews()).resolves.toBe(2)

    expect(await tree(PREVIEWS)).toEqual([])
  })

  it('changes nothing when it runs again', async () => {
    await live('a/keep.jpg')
    await thumb('a/keep.jpg')
    await thumb('a/gone.jpg')
    await thumb('old/gone.jpg')
    await removeOrphanPreviews()
    const after = await tree(UPLOADS)

    await expect(removeOrphanPreviews()).resolves.toBe(0)

    expect(await tree(UPLOADS)).toEqual(after)
    expect(after).toEqual(['.previews', '.previews/a', '.previews/a/keep.jpg', 'a', 'a/keep.jpg'])
  })

  it('does nothing, and creates nothing, without a .previews folder', async () => {
    await live('img.jpg')

    await expect(removeOrphanPreviews()).resolves.toBe(0)

    expect(await tree(UPLOADS)).toEqual(['img.jpg'])
  })

  it('does nothing without an uploads folder', async () => {
    await fs.rm(UPLOADS, { recursive: true })

    await expect(removeOrphanPreviews()).resolves.toBe(0)

    await expect(fs.access(UPLOADS)).rejects.toThrow()
  })

  it('touches nothing outside .previews', async () => {
    await live('img.jpg')
    await live('docs/readme.txt')
    await write(path.join(UPLOADS, '.trash', 'abc', 'old.jpg'), 'trashed')
    await write(path.join(UPLOADS, '.trash', 'abc', '.preview'), 'stashed thumb')
    await thumb('gone.jpg')

    await removeOrphanPreviews()

    expect(await tree(UPLOADS)).toEqual([
      '.previews', '.trash', '.trash/abc', '.trash/abc/.preview', '.trash/abc/old.jpg', 'docs', 'docs/readme.txt', 'img.jpg',
    ])
  })

  it('does not take a trashed file for a live one', async () => {
    await write(path.join(UPLOADS, '.trash', 'abc', 'old.jpg'), 'trashed')
    await thumb('.trash/abc/old.jpg')

    await expect(removeOrphanPreviews()).resolves.toBe(1)

    expect(await tree(PREVIEWS)).toEqual([])
    expect(await fs.readFile(path.join(UPLOADS, '.trash', 'abc', 'old.jpg'), 'utf-8')).toBe('trashed')
  })

  describe('links', () => {
    it('does not follow a linked folder inside .previews, nor remove the link', async () => {
      await write(path.join(OUTSIDE, 'photo.jpg'), 'not ours')
      await fs.mkdir(PREVIEWS, { recursive: true })
      await fs.symlink(OUTSIDE, path.join(PREVIEWS, 'linked'))
      await thumb('gone.jpg')

      await expect(removeOrphanPreviews()).resolves.toBe(1)

      expect(await fs.readFile(path.join(OUTSIDE, 'photo.jpg'), 'utf-8')).toBe('not ours')
      expect(await fs.readdir(PREVIEWS)).toEqual(['linked'])
    })

    it('leaves a linked file inside .previews, and what it points to', async () => {
      await write(path.join(OUTSIDE, 'photo.jpg'), 'not ours')
      await fs.mkdir(PREVIEWS, { recursive: true })
      await fs.symlink(path.join(OUTSIDE, 'photo.jpg'), path.join(PREVIEWS, 'linked.jpg'))

      await expect(removeOrphanPreviews()).resolves.toBe(0)

      expect(await fs.readFile(path.join(OUTSIDE, 'photo.jpg'), 'utf-8')).toBe('not ours')
      expect(await fs.readdir(PREVIEWS)).toEqual(['linked.jpg'])
    })

    it('does nothing when .previews itself is a link', async () => {
      await write(path.join(OUTSIDE, 'photo.jpg'), 'not ours')
      await fs.symlink(OUTSIDE, PREVIEWS)

      await expect(removeOrphanPreviews()).resolves.toBe(0)

      expect(await fs.readFile(path.join(OUTSIDE, 'photo.jpg'), 'utf-8')).toBe('not ours')
    })
  })

  describe('an entry it cannot handle', () => {
    const locked = path.join(PREVIEWS, 'locked')

    afterEach(async () => {
      await fs.chmod(locked, 0o755).catch(() => {})
    })

    it('is logged and skipped: the others are still removed', async () => {
      await thumb('locked/gone.jpg')
      await thumb('other/gone.jpg')
      await thumb('gone.jpg')
      await fs.chmod(locked, 0o000)

      await expect(removeOrphanPreviews()).resolves.toBe(2)

      expect(await fs.readdir(PREVIEWS)).toEqual(['locked'])
      expect(log).toHaveBeenCalled()
    })
  })
})
