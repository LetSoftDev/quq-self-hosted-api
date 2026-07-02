import { describe, it, expect, beforeEach } from 'vitest'
import { TrashStore } from './trash'

describe('TrashStore', () => {
  let store: TrashStore

  beforeEach(() => {
    store = new TrashStore(':memory:')
  })

  describe('add / getById', () => {
    it('inserts a row and retrieves it by id', () => {
      store.add('uuid-1', '/photos/cat.jpg', 'cat.jpg', 'file')
      const item = store.getById('uuid-1')
      expect(item).toBeDefined()
      expect(item!.id).toBe('uuid-1')
      expect(item!.original_path).toBe('/photos/cat.jpg')
      expect(item!.name).toBe('cat.jpg')
      expect(item!.type).toBe('file')
      expect(typeof item!.deleted_at).toBe('number')
    })

    it('returns undefined for unknown id', () => {
      expect(store.getById('nope')).toBeUndefined()
    })
  })

  describe('list', () => {
    it('returns items ordered by deleted_at DESC', () => {
      store.add('a', '/a.jpg', 'a.jpg', 'file')
      store.add('b', '/b.jpg', 'b.jpg', 'file')
      const { items } = store.list(50, 0)
      expect(items[0].id).toBe('b')
      expect(items[1].id).toBe('a')
    })

    it('paginates correctly', () => {
      store.add('a', '/a.jpg', 'a.jpg', 'file')
      store.add('b', '/b.jpg', 'b.jpg', 'file')
      store.add('c', '/c.jpg', 'c.jpg', 'file')
      const page1 = store.list(2, 0)
      expect(page1.items).toHaveLength(2)
      expect(page1.total).toBe(3)
      const page2 = store.list(2, 2)
      expect(page2.items).toHaveLength(1)
    })

    it('enforces 200 cap when limit exceeds 200', () => {
      for (let i = 0; i < 5; i++) store.add(`id${i}`, `/f${i}.jpg`, `f${i}.jpg`, 'file')
      const { items, total } = store.list(999, 0)
      expect(items).toHaveLength(5)
      expect(total).toBe(5)
    })

    it('total reflects count after removal', () => {
      store.add('x', '/x.jpg', 'x.jpg', 'file')
      expect(store.list(50, 0).total).toBe(1)
      store.remove('x')
      expect(store.list(50, 0).total).toBe(0)
    })
  })

  describe('remove', () => {
    it('deletes the row; getById returns undefined', () => {
      store.add('del', '/d.jpg', 'd.jpg', 'file')
      store.remove('del')
      expect(store.getById('del')).toBeUndefined()
    })
  })
})
