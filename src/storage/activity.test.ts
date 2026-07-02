import { describe, it, expect, beforeEach } from 'vitest'
import { ActivityStore } from './activity'

describe('ActivityStore', () => {
  let store: ActivityStore

  beforeEach(() => {
    store = new ActivityStore(':memory:')
  })

  it('record() inserts a row and getSummary() returns it in recentFiles', () => {
    store.record('/docs/report.pdf', 'report.pdf', 'file')
    const summary = store.getSummary()
    expect(summary.recentFiles.map(f => f.name)).toContain('report.pdf')
  })

  it('getSummary() returns empty arrays when no data', () => {
    const summary = store.getSummary()
    expect(summary.quickAccess).toEqual([])
    expect(summary.recentFiles).toEqual([])
  })

  it('quickAccess ranks by interaction count (most interactions first)', () => {
    store.record('/a.pdf', 'a.pdf', 'file')
    store.record('/a.pdf', 'a.pdf', 'file')
    store.record('/a.pdf', 'a.pdf', 'file')
    store.record('/b.pdf', 'b.pdf', 'file')
    store.record('/b.pdf', 'b.pdf', 'file')
    const summary = store.getSummary()
    expect(summary.quickAccess[0].name).toBe('a.pdf')
    expect(summary.quickAccess[1].name).toBe('b.pdf')
  })

  it('quickAccess contains only files, not directories', () => {
    store.record('/folder', 'folder', 'dir')
    store.record('/a.pdf', 'a.pdf', 'file')
    const summary = store.getSummary()
    expect(summary.quickAccess.every(f => f.type === 'file')).toBe(true)
  })

  it('recentFiles contains both files and dirs, ordered most recent first', () => {
    store.record('/folder', 'folder', 'dir')
    // busy-wait 2ms to ensure distinct accessed_at timestamps
    const start = Date.now()
    while (Date.now() - start < 2) { /* spin */ }
    store.record('/a.pdf', 'a.pdf', 'file')
    const summary = store.getSummary()
    expect(summary.recentFiles[0].name).toBe('a.pdf')
    expect(summary.recentFiles[1].name).toBe('folder')
  })

  it('quickAccess returns at most 5 items', () => {
    for (let i = 0; i < 10; i++) {
      store.record(`/file${i}.pdf`, `file${i}.pdf`, 'file')
    }
    expect(store.getSummary().quickAccess.length).toBeLessThanOrEqual(5)
  })

  it('recentFiles returns at most 10 items', () => {
    for (let i = 0; i < 15; i++) {
      store.record(`/file${i}.pdf`, `file${i}.pdf`, 'file')
    }
    expect(store.getSummary().recentFiles.length).toBeLessThanOrEqual(10)
  })

  it('getSummary() returns correct QuqFile shape', () => {
    store.record('/docs/report.pdf', 'report.pdf', 'file')
    const { recentFiles } = store.getSummary()
    expect(recentFiles[0]).toMatchObject({
      name: 'report.pdf',
      path: '/docs/report.pdf',
      type: 'file',
      url: '/files/docs/report.pdf',
    })
  })
})
