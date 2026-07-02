import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

export interface StarredRow {
  path: string
  name: string
  type: 'file' | 'dir'
  starred_at: number
}

export class StarStore {
  private db: Database.Database

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS starred_items (
        path       TEXT    PRIMARY KEY,
        name       TEXT    NOT NULL,
        type       TEXT    NOT NULL CHECK(type IN ('file','dir')),
        starred_at INTEGER NOT NULL
      )
    `)
  }

  toggle(filePath: string, name: string, type: 'file' | 'dir'): boolean {
    const existing = this.db
      .prepare('SELECT path FROM starred_items WHERE path = ?')
      .get(filePath)
    if (existing) {
      this.db.prepare('DELETE FROM starred_items WHERE path = ?').run(filePath)
      return false
    }
    this.db
      .prepare('INSERT INTO starred_items (path, name, type, starred_at) VALUES (?, ?, ?, ?)')
      .run(filePath, name, type, Date.now())
    return true
  }

  isStarred(filePath: string): boolean {
    return this.db
      .prepare('SELECT path FROM starred_items WHERE path = ?')
      .get(filePath) !== undefined
  }

  batchIsStarred(paths: string[]): Set<string> {
    if (paths.length === 0) return new Set()
    const placeholders = paths.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT path FROM starred_items WHERE path IN (${placeholders})`)
      .all(...paths) as { path: string }[]
    return new Set(rows.map(r => r.path))
  }

  list(limit = 200, offset = 0): { items: StarredRow[], total: number } {
    const cappedLimit = Math.min(limit, 200)
    const { count } = this.db
      .prepare('SELECT COUNT(*) as count FROM starred_items')
      .get() as { count: number }
    const items = this.db
      .prepare(`
        SELECT path, name, type, starred_at
        FROM starred_items
        ORDER BY
          CASE WHEN type = 'dir' THEN 0 ELSE 1 END ASC,
          name ASC
        LIMIT ? OFFSET ?
      `)
      .all(cappedLimit, offset) as StarredRow[]
    return { items, total: count }
  }

  updatePath(oldPath: string, newPath: string, newName: string): void {
    this.db
      .prepare('UPDATE starred_items SET path = ?, name = ? WHERE path = ?')
      .run(newPath, newName, oldPath)
  }
}
