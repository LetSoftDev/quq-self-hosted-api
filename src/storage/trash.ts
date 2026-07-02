import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

export interface TrashItem {
  id: string
  original_path: string
  name: string
  type: 'file' | 'dir'
  deleted_at: number
}

export class TrashStore {
  private db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    }
    this.db = new Database(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trash_items (
        id            TEXT PRIMARY KEY,
        original_path TEXT NOT NULL,
        name          TEXT NOT NULL,
        type          TEXT NOT NULL CHECK(type IN ('file','dir')),
        deleted_at    INTEGER NOT NULL
      )
    `)
  }

  add(id: string, originalPath: string, name: string, type: 'file' | 'dir'): void {
    this.db
      .prepare('INSERT INTO trash_items (id, original_path, name, type, deleted_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, originalPath, name, type, Date.now())
  }

  getById(id: string): TrashItem | undefined {
    return this.db
      .prepare('SELECT * FROM trash_items WHERE id = ?')
      .get(id) as TrashItem | undefined
  }

  list(limit: number, offset: number): { items: TrashItem[], total: number } {
    const safeLimit = Math.min(limit, 200)
    const { count } = this.db
      .prepare('SELECT COUNT(*) as count FROM trash_items')
      .get() as { count: number }
    const items = this.db
      .prepare('SELECT * FROM trash_items ORDER BY deleted_at DESC, rowid DESC LIMIT ? OFFSET ?')
      .all(safeLimit, offset) as TrashItem[]
    return { items, total: count }
  }

  remove(id: string): void {
    this.db.prepare('DELETE FROM trash_items WHERE id = ?').run(id)
  }
}
