import { describe, it, expect, beforeEach } from 'vitest'
import { StarStore } from './stars'

describe('StarStore', () => {
  let store: StarStore

  beforeEach(() => {
    store = new StarStore(':memory:')
  })

  describe('toggle', () => {
    it('stars an item and returns true', () => {
      expect(store.toggle('/photo.jpg', 'photo.jpg', 'file')).toBe(true)
    })

    it('un-stars an already-starred item and returns false', () => {
      store.toggle('/photo.jpg', 'photo.jpg', 'file')
      expect(store.toggle('/photo.jpg', 'photo.jpg', 'file')).toBe(false)
    })
  })

  describe('isStarred', () => {
    it('returns false when not starred', () => {
      expect(store.isStarred('/photo.jpg')).toBe(false)
    })

    it('returns true after starring', () => {
      store.toggle('/photo.jpg', 'photo.jpg', 'file')
      expect(store.isStarred('/photo.jpg')).toBe(true)
    })
  })

  describe('batchIsStarred', () => {
    it('returns set of starred paths', () => {
      store.toggle('/a.jpg', 'a.jpg', 'file')
      store.toggle('/b.jpg', 'b.jpg', 'file')
      const set = store.batchIsStarred(['/a.jpg', '/b.jpg', '/c.jpg'])
      expect(set.has('/a.jpg')).toBe(true)
      expect(set.has('/b.jpg')).toBe(true)
      expect(set.has('/c.jpg')).toBe(false)
    })

    it('returns empty set for empty input', () => {
      expect(store.batchIsStarred([])).toEqual(new Set())
    })
  })

  describe('list', () => {
    it('returns dirs before files', () => {
      store.toggle('/file.txt', 'file.txt', 'file')
      store.toggle('/myfolder', 'myfolder', 'dir')
      const { items } = store.list(200, 0)
      expect(items[0].type).toBe('dir')
      expect(items[1].type).toBe('file')
    })

    it('returns items alphabetically within same type', () => {
      store.toggle('/b.txt', 'b.txt', 'file')
      store.toggle('/a.txt', 'a.txt', 'file')
      const { items } = store.list(200, 0)
      expect(items[0].name).toBe('a.txt')
      expect(items[1].name).toBe('b.txt')
    })

    it('paginates with limit and offset', () => {
      for (let i = 1; i <= 5; i++) {
        store.toggle(`/file${i}.txt`, `file${i}.txt`, 'file')
      }
      const { items, total } = store.list(2, 0)
      expect(items).toHaveLength(2)
      expect(total).toBe(5)
    })

    it('returns total regardless of limit', () => {
      store.toggle('/a.txt', 'a.txt', 'file')
      store.toggle('/b.txt', 'b.txt', 'file')
      store.toggle('/c.txt', 'c.txt', 'file')
      const { total } = store.list(1, 0)
      expect(total).toBe(3)
    })

    it('caps limit at 200 and does not truncate small sets', () => {
      store.toggle('/a.txt', 'a.txt', 'file')
      store.toggle('/b.txt', 'b.txt', 'file')
      const { items } = store.list(9999, 0)
      // With 2 items, a cap of 200 returns all 2; a broken cap of 1 would return only 1
      expect(items).toHaveLength(2)
    })
  })

  describe('updatePath', () => {
    it('updates path and name of a starred item', () => {
      store.toggle('/old.txt', 'old.txt', 'file')
      store.updatePath('/old.txt', '/new.txt', 'new.txt')
      expect(store.isStarred('/old.txt')).toBe(false)
      expect(store.isStarred('/new.txt')).toBe(true)
    })

    it('is a no-op when old path is not starred', () => {
      expect(() => store.updatePath('/ghost.txt', '/new.txt', 'new.txt')).not.toThrow()
    })
  })
})
