import fs from 'fs/promises'
import path from 'path'
import { QuqFile, ListResponse } from '../types'

export class LocalStorage {
  constructor(private baseDir: string) {
    this.ensureBaseDir()
  }

  private async ensureBaseDir() {
    try {
      await fs.access(this.baseDir)
    } catch {
      await fs.mkdir(this.baseDir, { recursive: true })
    }
  }

  private resolvePath(relativePath: string): string {
    // Detect if this looks like an OS absolute path (not a virtual storage path)
    // Allow single '/' as root, but reject paths like '/etc', '/usr', '/var', etc.
    if (relativePath !== '/' && relativePath.startsWith('/') && !relativePath.startsWith('//')) {
      const afterSlash = relativePath.slice(1)
      // Check if it looks like a Unix system path
      const systemPaths = ['etc/', 'usr/', 'var/', 'tmp/', 'home/', 'root/', 'bin/', 'sbin/', 'lib/', 'opt/', 'proc/', 'sys/', 'dev/']
      if (systemPaths.some(sp => afterSlash.startsWith(sp) || afterSlash === sp.slice(0, -1))) {
        throw new Error('absolute paths not allowed')
      }
    }

    // Remove leading slash to treat as relative to baseDir
    const cleanPath = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath
    const normalized = path.normalize(cleanPath)

    // Check if the cleaned path is absolute (shouldn't happen after removing leading /)
    if (path.isAbsolute(cleanPath)) {
      throw new Error('absolute paths not allowed')
    }

    const segments = normalized.split(path.sep)
    if (segments.some(segment => segment === '..')) {
      throw new Error('path traversal detected')
    }

    const resolved = path.resolve(this.baseDir, normalized)
    const realBaseDir = path.resolve(this.baseDir)
    if (!resolved.startsWith(realBaseDir + path.sep) && resolved !== realBaseDir) {
      throw new Error('Invalid path: outside base directory')
    }

    return resolved
  }

  public async resolveConflictName(destDir: string, name: string): Promise<string> {
    const ext = path.extname(name)
    const base = path.basename(name, ext)
    const first = path.join(destDir, name)
    try {
      await fs.access(first)
    } catch {
      return name // no conflict
    }
    let i = 2
    while (true) {
      const candidate = `${base} (${i})${ext}`
      try {
        await fs.access(path.join(destDir, candidate))
        i++
      } catch {
        return candidate
      }
    }
  }

  async list(dirPath: string, limit?: number, offset = 0): Promise<ListResponse> {
    const fullPath = this.resolvePath(dirPath)
    const entries = await fs.readdir(fullPath, { withFileTypes: true })

    const visibleEntries = entries.filter(entry => entry.name !== '.previews' && entry.name !== '.trash')

    const previewDir = this.getPreviewDir(dirPath)
    const allFiles = await Promise.all(
      visibleEntries.map(async (entry) => {
        const entryPath = path.join(fullPath, entry.name)
        const stats = await fs.stat(entryPath)
        const relativePath = path.join(dirPath, entry.name)

        // Check if a preview thumbnail exists in centralized .previews
        const previewFilePath = path.join(previewDir, entry.name)
        let preview: string | undefined
        if (entry.isFile()) {
          try {
            await fs.access(previewFilePath)
            preview = `/api/preview?path=${encodeURIComponent(path.join(dirPath, entry.name))}`
          } catch {
            // No preview exists — leave undefined
          }
        }

        return {
          name: entry.name,
          path: relativePath,
          type: entry.isDirectory() ? 'dir' : 'file',
          url: `/files${relativePath}`,
          size: entry.isFile() ? stats.size : undefined,
          modified: stats.mtimeMs,
          mime: entry.isFile() ? this.getMimeType(entry.name) : undefined,
          ...(preview ? { preview } : {})
        } as QuqFile
      })
    )

    allFiles.sort((a, b) => {
      if (a.type === b.type) return a.name.localeCompare(b.name)
      return a.type === 'dir' ? -1 : 1
    })

    const total = allFiles.length
    const paginated = limit !== undefined ? allFiles.slice(offset, offset + limit) : allFiles

    return {
      files: paginated,
      total,
      hasMore: limit !== undefined ? offset + paginated.length < total : false
    }
  }

  async search(dirPath: string, query: string, limit = 200): Promise<ListResponse> {
    const results: QuqFile[] = []
    await this._walkSearch(dirPath, query.toLowerCase(), results, limit)
    return { files: results, total: results.length, hasMore: false }
  }

  private async _walkSearch(
    dirPath: string,
    lowerQuery: string,
    results: QuqFile[],
    limit: number
  ): Promise<void> {
    if (results.length >= limit) return
    let fullPath: string
    try {
      fullPath = this.resolvePath(dirPath)
    } catch {
      return
    }
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(fullPath, { withFileTypes: true })
    } catch {
      return
    }
    const visible = entries.filter(e => e.name !== '.previews' && e.name !== '.trash')
    for (const entry of visible) {
      if (results.length >= limit) break
      const relativePath = path.join(dirPath, entry.name)
      if (entry.name.toLowerCase().includes(lowerQuery)) {
        const entryPath = path.join(fullPath, entry.name)
        const stats = await fs.stat(entryPath)
        results.push({
          name: entry.name,
          path: relativePath,
          type: entry.isDirectory() ? 'dir' : 'file',
          url: `/files${relativePath}`,
          size: entry.isFile() ? stats.size : undefined,
          modified: stats.mtimeMs,
          mime: entry.isFile() ? this.getMimeType(entry.name) : undefined,
        } as QuqFile)
      }
      if (entry.isDirectory()) {
        await this._walkSearch(relativePath, lowerQuery, results, limit)
      }
    }
  }

  async upload(file: Express.Multer.File, targetPath: string): Promise<QuqFile> {
    const targetDir = this.resolvePath(targetPath)
    await fs.mkdir(targetDir, { recursive: true })

    const targetFile = path.join(targetDir, file.originalname)
    await this.moveUploadedFile(file.path, targetFile)

    const stats = await fs.stat(targetFile)
    const relativePath = path.join(targetPath, file.originalname)

    return {
      name: file.originalname,
      path: relativePath,
      type: 'file',
      url: `/files${relativePath}`,
      size: stats.size,
      modified: stats.mtimeMs,
      mime: file.mimetype
    }
  }

  private async moveUploadedFile(sourcePath: string, targetPath: string): Promise<void> {
    try {
      await fs.rename(sourcePath, targetPath)
    } catch (err: any) {
      if (err?.code !== 'EXDEV') throw err

      await fs.copyFile(sourcePath, targetPath)
      await fs.unlink(sourcePath)
    }
  }

  /** Absolute path to the centralized previews root: baseDir/.previews */
  private get previewsRoot(): string {
    return path.join(path.resolve(this.baseDir), '.previews')
  }

  /** Returns absolute path to the previews directory for a given dir path */
  getPreviewDir(dirPath: string): string {
    const clean = dirPath.startsWith('/') ? dirPath.slice(1) : dirPath
    return clean ? path.join(this.previewsRoot, clean) : this.previewsRoot
  }

  /** Returns the absolute resolved path for a given relative path */
  resolvePublic(dirPath: string): string {
    return this.resolvePath(dirPath)
  }

  /**
   * Returns the absolute path to the preview file for a given original file path.
   * Validates the resulting path against path traversal.
   * @param originalRelativePath e.g. "/photos/cat.jpg"
   */
  getPreviewPath(originalRelativePath: string): string {
    const clean = originalRelativePath.startsWith('/') ? originalRelativePath.slice(1) : originalRelativePath
    const normalized = path.normalize(clean)
    if (normalized.split(path.sep).some(s => s === '..')) {
      throw new Error('path traversal detected')
    }
    const resolved = path.join(this.previewsRoot, normalized)
    if (!resolved.startsWith(this.previewsRoot + path.sep)) {
      throw new Error('Invalid path: outside previews directory')
    }
    return resolved
  }

  async mkdir(dirPath: string): Promise<void> {
    const fullPath = this.resolvePath(dirPath)
    await fs.mkdir(fullPath, { recursive: true })
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const absOld = this.resolvePath(oldPath)
    const absNewResolved = this.resolvePath(newPath)
    if (absOld === absNewResolved) return // same path: no-op
    const destDir = path.dirname(absNewResolved)
    const filename = path.basename(absNewResolved)
    const finalName = await this.resolveConflictName(destDir, filename)
    const absDest = path.join(destDir, finalName)
    await fs.rename(absOld, absDest)
  }

  /**
   * Copies a file or directory to the destination directory.
   * Requires Node.js 16.7+ for fs.cp (directory copying).
   */
  async copy(srcPath: string, destDir: string): Promise<void> {
    const absSrc = this.resolvePath(srcPath)
    const absDestDir = this.resolvePath(destDir)
    const finalName = await this.resolveConflictName(absDestDir, path.basename(absSrc))
    const absDest = path.join(absDestDir, finalName)
    const stats = await fs.stat(absSrc)
    if (stats.isDirectory()) {
      await fs.cp(absSrc, absDest, { recursive: true })
    } else {
      await fs.copyFile(absSrc, absDest)
    }
  }

  async delete(paths: string[]): Promise<void> {
    await Promise.all(
      paths.map(async (filePath) => {
        const fullPath = this.resolvePath(filePath)
        const stats = await fs.stat(fullPath)
        if (stats.isDirectory()) {
          await fs.rm(fullPath, { recursive: true })
        } else {
          await fs.unlink(fullPath)
          // Clean up preview thumbnail if it exists
          const relPath = path.relative(path.resolve(this.baseDir), fullPath)
          const previewPath = path.join(this.previewsRoot, relPath)
          try {
            await fs.unlink(previewPath)
          } catch (err: any) {
            if (err.code !== 'ENOENT') {
              console.error(`[thumbnail] Failed to delete preview for ${path.basename(fullPath)}:`, err)
            }
            // ENOENT = no preview exists, that's fine
          }
        }
      })
    )
  }

  private getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase()
    const mimeMap: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.doc': 'application/msword',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.xls': 'application/vnd.ms-excel',
      '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      '.txt': 'text/plain',
      '.csv': 'text/csv',
      '.json': 'application/json',
      '.xml': 'application/xml',
      '.html': 'text/html',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.avi': 'video/x-msvideo',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.zip': 'application/zip',
      '.rar': 'application/x-rar-compressed',
      '.7z': 'application/x-7z-compressed'
    }
    return mimeMap[ext] || 'application/octet-stream'
  }
}
