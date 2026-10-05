import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { LocalStorage } from './local'
import type { QuqFile } from '../types'
import { RequestError } from '../http-errors'
import fs from 'fs/promises'
import path from 'path'

const TEST_DIR = path.join(process.cwd(), 'temp', 'test-storage')

describe('LocalStorage', () => {
  let storage: LocalStorage

  beforeEach(async () => {
    // Clean up first, then create fresh directory
    await fs.rm(TEST_DIR, { recursive: true, force: true })
    await fs.mkdir(TEST_DIR, { recursive: true })
    storage = new LocalStorage(TEST_DIR)
  })

  afterEach(async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true })
  })

  describe('list', () => {
    it('should list files and directories', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'file1.txt'), 'content')
      await fs.mkdir(path.join(TEST_DIR, 'folder1'))

      const result = await storage.list('/')

      expect(result.files).toHaveLength(2)
      expect(result.files.find(f => f.name === 'file1.txt')).toBeDefined()
      expect(result.files.find(f => f.name === 'folder1' && f.type === 'dir')).toBeDefined()
    })

    it('should return ListResponse shape with total and hasMore', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'a.txt'), '')
      await fs.writeFile(path.join(TEST_DIR, 'b.txt'), '')

      const result = await storage.list('/')
      expect(result).toHaveProperty('files')
      expect(result).toHaveProperty('total', 2)
      expect(result).toHaveProperty('hasMore', false)
    })

    it('should paginate with limit and offset', async () => {
      for (let i = 1; i <= 5; i++) {
        await fs.writeFile(path.join(TEST_DIR, `file${i}.txt`), '')
      }

      const result = await storage.list('/', 2, 0)
      expect(result.files).toHaveLength(2)
      expect(result.total).toBe(5)
      expect(result.hasMore).toBe(true)
    })

    it('should return hasMore=false when last page is reached', async () => {
      for (let i = 1; i <= 3; i++) {
        await fs.writeFile(path.join(TEST_DIR, `file${i}.txt`), '')
      }

      const result = await storage.list('/', 2, 2)
      expect(result.files).toHaveLength(1)
      expect(result.hasMore).toBe(false)
    })

    it('should return directories before files', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'afile.txt'), '')
      await fs.mkdir(path.join(TEST_DIR, 'bfolder'))

      const result = await storage.list('/')
      expect(result.files[0].type).toBe('dir')
      expect(result.files[1].type).toBe('file')
    })

    it('should not include .previews directory in listing', async () => {
      await fs.mkdir(path.join(TEST_DIR, '.previews'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, 'visible.txt'), '')

      const result = await storage.list('/')
      expect(result.files.find(f => f.name === '.previews')).toBeUndefined()
      expect(result.files.find(f => f.name === 'visible.txt')).toBeDefined()
    })

    it('should throw on path traversal with ".."', async () => {
      await expect(storage.list('../etc')).rejects.toThrow('path traversal detected')
    })

    it('should throw on absolute paths', async () => {
      await expect(storage.list('/etc/passwd')).rejects.toThrow('absolute paths not allowed')
    })

    it('should include preview URL when .previews/{name}.jpg exists', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'photo.jpg'), '')
      await fs.mkdir(path.join(TEST_DIR, '.previews'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, '.previews', 'photo.jpg'), '') // centralized: baseDir/.previews/photo.jpg

      const result = await storage.list('/')
      const file = result.files.find(f => f.name === 'photo.jpg')
      expect(file?.preview).toBe('/api/preview?path=%2Fphoto.jpg')
    })

    it('should not include preview when .previews/{name}.jpg does not exist', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'doc.txt'), '')

      const result = await storage.list('/')
      const file = result.files.find(f => f.name === 'doc.txt')
      expect(file?.preview).toBeUndefined()
    })

    it('filters out .trash directory from list results', async () => {
      // Create .trash dir inside the test uploads dir
      await fs.mkdir(path.join(TEST_DIR, '.trash'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, 'visible.txt'), 'hello')
      const result = await storage.list('/')
      const names = result.files.map((f: QuqFile) => f.name)
      expect(names).not.toContain('.trash')
      expect(names).toContain('visible.txt')
    })
  })

  describe('upload', () => {
    it('copies and removes the temp file when rename crosses devices', async () => {
      const tempDir = path.join(process.cwd(), 'temp', 'test-storage-temp')
      await fs.mkdir(tempDir, { recursive: true })
      const tempFile = path.join(tempDir, 'upload.tmp')
      await fs.writeFile(tempFile, 'uploaded content')

      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(
        Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
      )

      const result = await storage.upload({
        path: tempFile,
        originalname: 'photo.jpg',
        mimetype: 'image/jpeg',
      } as Express.Multer.File, '/')

      expect(result).toMatchObject({
        name: 'photo.jpg',
        path: '/photo.jpg',
        url: '/files/photo.jpg',
        mime: 'image/jpeg',
      })
      await expect(fs.readFile(path.join(TEST_DIR, 'photo.jpg'), 'utf8')).resolves.toBe('uploaded content')
      await expect(fs.access(tempFile)).rejects.toThrow()

      renameSpy.mockRestore()
      await fs.rm(tempDir, { recursive: true, force: true })
    })
  })

  describe('mkdir', () => {
    it('should create directory', async () => {
      await storage.mkdir('/newfolder')

      const stats = await fs.stat(path.join(TEST_DIR, 'newfolder'))
      expect(stats.isDirectory()).toBe(true)
    })
  })

  describe('delete', () => {
    it('should delete files', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'delete-me.txt'), 'content')

      await storage.delete(['/delete-me.txt'])

      await expect(fs.access(path.join(TEST_DIR, 'delete-me.txt'))).rejects.toThrow()
    })

    it('should delete directories recursively', async () => {
      await fs.mkdir(path.join(TEST_DIR, 'delete-folder'))
      await fs.writeFile(path.join(TEST_DIR, 'delete-folder', 'file.txt'), 'content')

      await storage.delete(['/delete-folder'])

      await expect(fs.access(path.join(TEST_DIR, 'delete-folder'))).rejects.toThrow()
    })

    it('should delete the preview thumbnail when deleting an image file', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'photo.jpg'), '')
      await fs.mkdir(path.join(TEST_DIR, '.previews'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, '.previews', 'photo.jpg'), '') // centralized

      await storage.delete(['/photo.jpg'])

      await expect(fs.access(path.join(TEST_DIR, '.previews', 'photo.jpg'))).rejects.toThrow()
    })

    it('should delete the previews of a deleted folder', async () => {
      await fs.mkdir(path.join(TEST_DIR, 'album', 'inner'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, 'album', 'inner', 'photo.jpg'), '')
      await fs.mkdir(path.join(TEST_DIR, '.previews', 'album', 'inner'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, '.previews', 'album', 'inner', 'photo.jpg'), '')
      await fs.writeFile(path.join(TEST_DIR, '.previews', 'other.jpg'), '')

      await storage.delete(['/album'])

      await expect(fs.access(path.join(TEST_DIR, '.previews', 'album'))).rejects.toThrow()
      // Only its own previews.
      await expect(fs.access(path.join(TEST_DIR, '.previews', 'other.jpg'))).resolves.toBeUndefined()
    })

    it('should succeed when deleting a file that has no preview', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'nodoc.txt'), '')

      await expect(storage.delete(['/nodoc.txt'])).resolves.toBeUndefined()
    })
  })

  describe('rename', () => {
    it('should rename a file', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'old.txt'), 'content')

      await storage.rename('/old.txt', '/new.txt')

      await expect(fs.access(path.join(TEST_DIR, 'new.txt'))).resolves.toBeUndefined()
      await expect(fs.access(path.join(TEST_DIR, 'old.txt'))).rejects.toThrow()
    })

    it('should rename a folder', async () => {
      await fs.mkdir(path.join(TEST_DIR, 'oldfolder'))

      await storage.rename('/oldfolder', '/newfolder')

      const stats = await fs.stat(path.join(TEST_DIR, 'newfolder'))
      expect(stats.isDirectory()).toBe(true)
    })

    it('should auto-rename when destination already exists', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'a.txt'), 'a')
      await fs.writeFile(path.join(TEST_DIR, 'b.txt'), 'b')

      await storage.rename('/a.txt', '/b.txt')

      await expect(fs.access(path.join(TEST_DIR, 'b (2).txt'))).resolves.toBeUndefined()
      await expect(fs.access(path.join(TEST_DIR, 'a.txt'))).rejects.toThrow()
    })

    it('should throw on path traversal', async () => {
      await expect(storage.rename('/file.txt', '../outside.txt')).rejects.toThrow('path traversal detected')
    })

    it('should be a no-op when oldPath and newPath resolve to the same file', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'same.txt'), 'content')
      const storage = new LocalStorage(TEST_DIR)
      await storage.rename('/same.txt', '/same.txt')
      await expect(fs.access(path.join(TEST_DIR, 'same.txt'))).resolves.toBeUndefined()
    })

    it('should increment counter when destination (2) also exists', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'a.txt'), 'a')
      await fs.writeFile(path.join(TEST_DIR, 'b.txt'), 'b')
      await fs.writeFile(path.join(TEST_DIR, 'b (2).txt'), 'b2')
      const storage = new LocalStorage(TEST_DIR)
      await storage.rename('/a.txt', '/b.txt')
      await expect(fs.access(path.join(TEST_DIR, 'b (3).txt'))).resolves.toBeUndefined()
    })

    it('should move a file preview when renaming an image', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'old.png'), 'image')
      await fs.mkdir(path.join(TEST_DIR, '.previews'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, '.previews', 'old.png'), 'preview')

      await storage.rename('/old.png', '/new.png')

      await expect(fs.access(path.join(TEST_DIR, '.previews', 'old.png'))).rejects.toThrow()
      await expect(fs.readFile(path.join(TEST_DIR, '.previews', 'new.png'), 'utf8')).resolves.toBe('preview')
      const result = await storage.list('/')
      expect(result.files.find(file => file.name === 'new.png')?.preview).toBe('/api/preview?path=%2Fnew.png')
    })

    it('should move nested previews when renaming a folder', async () => {
      await fs.mkdir(path.join(TEST_DIR, 'oldfolder', 'nested'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, 'oldfolder', 'nested', 'photo.png'), 'image')
      await fs.mkdir(path.join(TEST_DIR, '.previews', 'oldfolder', 'nested'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, '.previews', 'oldfolder', 'nested', 'photo.png'), 'preview')

      await storage.rename('/oldfolder', '/newfolder')

      await expect(fs.access(path.join(TEST_DIR, '.previews', 'oldfolder'))).rejects.toThrow()
      await expect(fs.readFile(path.join(TEST_DIR, '.previews', 'newfolder', 'nested', 'photo.png'), 'utf8')).resolves.toBe('preview')
      const result = await storage.list('/newfolder/nested')
      expect(result.files.find(file => file.name === 'photo.png')?.preview).toBe('/api/preview?path=%2Fnewfolder%2Fnested%2Fphoto.png')
    })
  })

  describe('LocalStorage.search()', () => {
    it('finds a file by partial name match', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'report.pdf'), 'data')
      const result = await storage.search('/', 'report')
      expect(result.files.map(f => f.name)).toContain('report.pdf')
    })

    it('search is case-insensitive', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'MyPhoto.jpg'), 'data')
      const result = await storage.search('/', 'myphoto')
      expect(result.files.map(f => f.name)).toContain('MyPhoto.jpg')
    })

    it('finds files recursively in subdirectories', async () => {
      await fs.mkdir(path.join(TEST_DIR, 'sub'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, 'sub', 'deep.txt'), 'data')
      const result = await storage.search('/', 'deep')
      expect(result.files.map(f => f.name)).toContain('deep.txt')
    })

    it('respects the limit', async () => {
      for (let i = 0; i < 5; i++) {
        await fs.writeFile(path.join(TEST_DIR, `match_${i}.txt`), '')
      }
      const result = await storage.search('/', 'match', 3)
      expect(result.files.length).toBe(3)
    })

    it('returns hasMore: false even when results are found', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'found.txt'), 'data')
      const result = await storage.search('/', 'found')
      expect(result.hasMore).toBe(false)
      expect(result.files.length).toBeGreaterThan(0)
    })

    it('does not recurse into .trash during search', async () => {
      await fs.mkdir(path.join(TEST_DIR, '.trash', 'some-uuid'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, '.trash', 'some-uuid', 'secret.txt'), 'x')
      const result = await storage.search('/', 'secret')
      expect(result.files).toHaveLength(0)
    })
  })

  describe('copy', () => {
    it('should copy a file to a directory — file appears at destination with original name', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'source.txt'), 'file content')
      await fs.mkdir(path.join(TEST_DIR, 'destdir'))

      await storage.copy('/source.txt', '/destdir')

      const copied = await fs.readFile(path.join(TEST_DIR, 'destdir', 'source.txt'), 'utf-8')
      expect(copied).toBe('file content')
      // Original should still exist
      const original = await fs.readFile(path.join(TEST_DIR, 'source.txt'), 'utf-8')
      expect(original).toBe('file content')
    })

    it('should auto-rename when destination already has a file with the same name', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'file.txt'), 'original')
      await fs.mkdir(path.join(TEST_DIR, 'destdir'))
      await fs.writeFile(path.join(TEST_DIR, 'destdir', 'file.txt'), 'existing')

      await storage.copy('/file.txt', '/destdir')

      const renamed = await fs.readFile(path.join(TEST_DIR, 'destdir', 'file (2).txt'), 'utf-8')
      expect(renamed).toBe('original')
      const existing = await fs.readFile(path.join(TEST_DIR, 'destdir', 'file.txt'), 'utf-8')
      expect(existing).toBe('existing')
    })

    it('should copy a directory recursively — destination dir contains all source files', async () => {
      const sourceDir = path.join(TEST_DIR, 'sourcedir')
      await fs.mkdir(sourceDir)
      await fs.writeFile(path.join(sourceDir, 'file1.txt'), 'content1')
      await fs.writeFile(path.join(sourceDir, 'file2.txt'), 'content2')
      await fs.mkdir(path.join(sourceDir, 'subdir'))
      await fs.writeFile(path.join(sourceDir, 'subdir', 'file3.txt'), 'content3')
      await fs.mkdir(path.join(TEST_DIR, 'destparent'))

      await storage.copy('/sourcedir', '/destparent')

      const file1 = await fs.readFile(path.join(TEST_DIR, 'destparent', 'sourcedir', 'file1.txt'), 'utf-8')
      expect(file1).toBe('content1')
      const file2 = await fs.readFile(path.join(TEST_DIR, 'destparent', 'sourcedir', 'file2.txt'), 'utf-8')
      expect(file2).toBe('content2')
      const file3 = await fs.readFile(path.join(TEST_DIR, 'destparent', 'sourcedir', 'subdir', 'file3.txt'), 'utf-8')
      expect(file3).toBe('content3')
    })

    it('should copy a file preview so pasted images keep thumbnails', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'photo.png'), 'image')
      await fs.mkdir(path.join(TEST_DIR, '.previews'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, '.previews', 'photo.png'), 'preview')
      await fs.mkdir(path.join(TEST_DIR, 'destdir'))

      await storage.copy('/photo.png', '/destdir')

      await expect(fs.readFile(path.join(TEST_DIR, '.previews', 'destdir', 'photo.png'), 'utf8')).resolves.toBe('preview')
      const result = await storage.list('/destdir')
      expect(result.files.find(file => file.name === 'photo.png')?.preview).toBe('/api/preview?path=%2Fdestdir%2Fphoto.png')
    })

    it('should copy a file preview using the resolved conflict name', async () => {
      await fs.writeFile(path.join(TEST_DIR, 'photo.png'), 'image')
      await fs.mkdir(path.join(TEST_DIR, '.previews'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, '.previews', 'photo.png'), 'preview')
      await fs.mkdir(path.join(TEST_DIR, 'destdir'))
      await fs.writeFile(path.join(TEST_DIR, 'destdir', 'photo.png'), 'existing')

      await storage.copy('/photo.png', '/destdir')

      await expect(fs.readFile(path.join(TEST_DIR, '.previews', 'destdir', 'photo (2).png'), 'utf8')).resolves.toBe('preview')
      const result = await storage.list('/destdir')
      expect(result.files.find(file => file.name === 'photo (2).png')?.preview).toBe('/api/preview?path=%2Fdestdir%2Fphoto%20(2).png')
    })

    it('should copy nested previews when copying a directory', async () => {
      await fs.mkdir(path.join(TEST_DIR, 'sourcedir', 'nested'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, 'sourcedir', 'nested', 'photo.png'), 'image')
      await fs.mkdir(path.join(TEST_DIR, '.previews', 'sourcedir', 'nested'), { recursive: true })
      await fs.writeFile(path.join(TEST_DIR, '.previews', 'sourcedir', 'nested', 'photo.png'), 'preview')
      await fs.mkdir(path.join(TEST_DIR, 'destparent'))

      await storage.copy('/sourcedir', '/destparent')

      await expect(fs.readFile(path.join(TEST_DIR, '.previews', 'destparent', 'sourcedir', 'nested', 'photo.png'), 'utf8')).resolves.toBe('preview')
      const result = await storage.list('/destparent/sourcedir/nested')
      expect(result.files.find(file => file.name === 'photo.png')?.preview).toBe('/api/preview?path=%2Fdestparent%2Fsourcedir%2Fnested%2Fphoto.png')
    })
  })

  describe('internal folders and the root', () => {
    // Its own folder, never temp/ itself: multer writes there and another test counts its files.
    const UPLOAD_TEMP = path.join(process.cwd(), 'temp', 'test-storage-temp')

    it.each(['/.trash', '/.trash/abc/secret.txt', '.previews', '/.previews/a.jpg', '/.TRASH/x'])(
      'refuses the reserved path %s',
      async reserved => {
        await expect(storage.list(reserved)).rejects.toThrow('path not allowed')
        await expect(storage.mkdir(reserved)).rejects.toThrow('path not allowed')
        await expect(storage.copy(reserved, '/')).rejects.toThrow('path not allowed')
        await expect(storage.rename(reserved, '/out')).rejects.toThrow('path not allowed')
        await expect(storage.delete([reserved])).rejects.toThrow('path not allowed')
        expect(() => storage.resolvePublic(reserved)).toThrow('path not allowed')
      },
    )

    // What a case-insensitive or normalising file system (APFS, NTFS) opens as the same folder.
    // Checked on the name alone: the answer must not depend on the disk the tests run on.
    it.each([
      ['a compatibility character', '/.tra\u017Fh/abc/secret.txt'],
      ['a trailing dot', '/.trash./abc/secret.txt'],
      ['a trailing space', '/.trash /abc/secret.txt'],
      ['trailing dots and spaces', '/.previews. ./a.jpg'],
      ['full-width letters', '/.\uFF34\uFF32\uFF21\uFF33\uFF28'],
    ])('refuses a reserved folder spelled with %s', async (_what, reserved) => {
      await expect(storage.list(reserved)).rejects.toThrow('path not allowed')
      await expect(storage.mkdir(reserved)).rejects.toThrow('path not allowed')
      await expect(storage.delete([reserved])).rejects.toThrow('path not allowed')
      expect(() => storage.resolvePublic(reserved)).toThrow('path not allowed')
      await expect(fs.access(path.join(TEST_DIR, '.trash'))).rejects.toThrow()
    })

    it.each(['/.trashed', '/.trash.old', '/trash', '/.previews2'])('still allows the ordinary name %s', async allowed => {
      expect(() => storage.resolvePublic(allowed)).not.toThrow()
    })

    // Thumbnails are public: no path into an internal folder may name one.
    it.each(['/.trash', '/.trash/abc/a.jpg', '.previews', '/.previews/a.jpg', '/.TRASH/x', '/.tra\u017Fh/a.jpg', '/.previews. ./a.jpg'])(
      'has no preview path for the reserved path %s',
      reserved => {
        expect(() => storage.getPreviewPath(reserved)).toThrow(new RequestError('path not allowed'))
        expect(() => storage.getPreviewDir(reserved)).toThrow(new RequestError('path not allowed'))
      },
    )

    it('keeps the preview paths of ordinary files and folders', () => {
      const previews = path.join(path.resolve(TEST_DIR), '.previews')

      expect(storage.getPreviewPath('/photos/cat.jpg')).toBe(path.join(previews, 'photos', 'cat.jpg'))
      expect(storage.getPreviewPath('/projects/.trash/cat.jpg')).toBe(path.join(previews, 'projects', '.trash', 'cat.jpg'))
      expect(storage.getPreviewDir('/')).toBe(previews)
      expect(storage.getPreviewDir('')).toBe(previews)
      expect(storage.getPreviewDir('/photos')).toBe(path.join(previews, 'photos'))
    })

    // JSON and `?path[]=a` deliver anything; a NUL byte makes fs throw a TypeError.
    it.each([5, ['a'], { a: 1 }, null, undefined, true, '/a\u0000b'])('refuses %j as a path', async bad => {
      const invalid = bad as string
      await fs.mkdir(UPLOAD_TEMP, { recursive: true })
      const temp = path.join(UPLOAD_TEMP, `upload-${Date.now()}-${Math.random()}`)
      await fs.writeFile(temp, 'x')

      expect(() => storage.resolvePublic(invalid)).toThrow(new RequestError('Invalid path'))
      expect(() => storage.getPreviewPath(invalid)).toThrow(new RequestError('Invalid path'))
      expect(() => storage.getPreviewDir(invalid)).toThrow(new RequestError('Invalid path'))
      await expect(storage.list(invalid)).rejects.toThrow(new RequestError('Invalid path'))
      await expect(storage.upload({ path: temp, originalname: 'a.txt', mimetype: 'text/plain' } as any, invalid))
        .rejects.toThrow(new RequestError('Invalid path'))
      await fs.rm(UPLOAD_TEMP, { recursive: true, force: true })
    })

    it('still allows a folder with that name below the root', async () => {
      await storage.mkdir('/projects/.trash')

      await expect(storage.list('/projects/.trash')).resolves.toMatchObject({ total: 0 })
    })

    it('refuses to delete or rename the storage root', async () => {
      await expect(storage.delete(['/'])).rejects.toThrow('cannot modify the storage root')
      await expect(storage.rename('/', '/x')).rejects.toThrow('cannot modify the storage root')
    })

    it.each(['.trash', '.previews', '..', '.', '', 'a/b.txt', 'a\\b.txt'])(
      'refuses the upload name %j',
      async originalname => {
        await fs.mkdir(UPLOAD_TEMP, { recursive: true })
        const temp = path.join(UPLOAD_TEMP, `upload-${Date.now()}-${Math.random()}`)
        await fs.writeFile(temp, 'x')

        await expect(storage.upload({ path: temp, originalname, mimetype: 'text/plain' } as any, '/'))
          .rejects.toThrow(/path not allowed|invalid file name/)
        await fs.rm(UPLOAD_TEMP, { recursive: true, force: true })
      },
    )

    it('reports the type by the file name, not by what the client declared', async () => {
      await fs.mkdir(UPLOAD_TEMP, { recursive: true })
      const temp = path.join(UPLOAD_TEMP, `upload-${Date.now()}`)
      await fs.writeFile(temp, '<script>1</script>')

      const file = await storage.upload({ path: temp, originalname: 'page.html', mimetype: 'image/png' } as any, '/')

      expect(file.mime).toBe('text/html')
      await fs.rm(UPLOAD_TEMP, { recursive: true, force: true })
    })
  })
})
