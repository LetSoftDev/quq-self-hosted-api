import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { walkUploads } from './walk-uploads'

const ROOT = path.join(process.cwd(), 'temp', 'test-walk-uploads')

describe('walkUploads', () => {
  const write = async (relativePath: string) => {
    await fs.mkdir(path.dirname(path.join(ROOT, relativePath)), { recursive: true })
    await fs.writeFile(path.join(ROOT, relativePath), 'x')
  }
  const visited = async (root = ROOT) => {
    const files: string[] = []
    const unreadable: string[] = []
    await walkUploads(
      root,
      async file => { files.push(path.relative(root, file).split(path.sep).join('/')) },
      dir => { unreadable.push(dir) },
    )
    return { files: files.sort(), unreadable }
  }

  beforeEach(async () => {
    await fs.rm(ROOT, { recursive: true, force: true })
    await fs.mkdir(ROOT, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(ROOT, { recursive: true, force: true })
  })

  it('visits the files of the root and of the folders below it', async () => {
    await write('a.jpg')
    await write('photos/b.jpg')
    await write('photos/2024/c.txt')
    await fs.mkdir(path.join(ROOT, 'empty'))

    expect(await visited()).toEqual({ files: ['a.jpg', 'photos/2024/c.txt', 'photos/b.jpg'], unreadable: [] })
  })

  // The script would give a trashed file a thumbnail in .previews, where anyone can fetch it.
  it('does not visit a trashed file', async () => {
    await write('a.jpg')
    await write('.trash/3f2c/img.jpg')
    await write('.trash/7a1e/album/inner/img.jpg')
    await write('.trash/7a1e/.preview/inner/img.jpg')

    expect((await visited()).files).toEqual(['a.jpg'])
  })

  it('does not visit the thumbnails', async () => {
    await write('a.jpg')
    await write('.previews/a.jpg')
    await write('.previews/photos/b.jpg')
    // As before: by name, at any depth.
    await write('photos/.previews/b.jpg')

    expect((await visited()).files).toEqual(['a.jpg'])
  })

  it('visits a folder of the user named .trash below the root', async () => {
    await write('projects/.trash/img.jpg')

    expect((await visited()).files).toEqual(['projects/.trash/img.jpg'])
  })

  it('reports a directory it cannot read', async () => {
    const missing = path.join(ROOT, 'missing')

    expect(await visited(missing)).toEqual({ files: [], unreadable: [missing] })
  })
})
