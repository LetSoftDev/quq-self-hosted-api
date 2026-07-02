import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'
import type { QuqFile, ActivitySummary } from '../types'

export class ActivityStore {
  private db: Database.Database

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        path        TEXT    NOT NULL,
        name        TEXT    NOT NULL,
        type        TEXT    NOT NULL CHECK(type IN ('file', 'dir')),
        accessed_at INTEGER NOT NULL
      )
    `)
  }

  record(path: string, name: string, type: 'file' | 'dir'): void {
    this.db
      .prepare('INSERT INTO file_events (path, name, type, accessed_at) VALUES (?, ?, ?, ?)')
      .run(path, name, type, Date.now())
  }

  getSummary(): ActivitySummary {
    const quickAccess = this.db
      .prepare(`
        SELECT path, name, type, MAX(accessed_at) AS modified
        FROM file_events
        WHERE type = 'file'
        GROUP BY path
        ORDER BY COUNT(*) DESC
        LIMIT 5
      `)
      .all() as { path: string; name: string; type: 'file' | 'dir'; modified: number }[]

    const recentFiles = this.db
      .prepare(`
        SELECT path, name, type, MAX(accessed_at) AS modified
        FROM file_events
        GROUP BY path
        ORDER BY MAX(accessed_at) DESC
        LIMIT 10
      `)
      .all() as { path: string; name: string; type: 'file' | 'dir'; modified: number }[]

    const toQuqFile = (row: {
      path: string
      name: string
      type: 'file' | 'dir'
      modified: number
    }): QuqFile => ({
      name: row.name,
      path: row.path,
      type: row.type,
      url: '/files' + row.path,
      modified: row.modified,
    })

    return {
      quickAccess: quickAccess.map(toQuqFile),
      recentFiles: recentFiles.map(toQuqFile),
    }
  }
}
