import { describe, it, expect, vi } from 'vitest'
import { FailureLimiter } from './failure-limiter'

const make = (options = { limit: 3, windowMs: 60_000, blockMs: 600_000, maxEntries: 2 }) => {
  let now = 1_000_000
  const limiter = new FailureLimiter(() => now, options)
  return { limiter, advance: (ms: number) => { now += ms } }
}

describe('FailureLimiter', () => {
  it('blocks an address after the limit of failures inside the window', () => {
    const { limiter } = make()

    limiter.recordFailure('a')
    limiter.recordFailure('a')
    expect(limiter.blockedFor('a')).toBe(0)

    limiter.recordFailure('a')
    expect(limiter.blockedFor('a')).toBe(600)
    expect(limiter.blockedFor('b')).toBe(0)
  })

  it('forgets failures older than the window', () => {
    const { limiter, advance } = make()

    limiter.recordFailure('a')
    limiter.recordFailure('a')
    advance(61_000)
    limiter.recordFailure('a')

    expect(limiter.blockedFor('a')).toBe(0)
  })

  it('lifts the block when it runs out', () => {
    const { limiter, advance } = make()
    for (let i = 0; i < 3; i++) limiter.recordFailure('a')

    advance(600_001)

    expect(limiter.blockedFor('a')).toBe(0)
  })

  it('keeps at most maxEntries addresses, dropping the oldest', () => {
    const { limiter } = make()

    limiter.recordFailure('a')
    limiter.recordFailure('b')
    limiter.recordFailure('c')

    expect(limiter.size()).toBe(2)
  })

  it('can be cleared', () => {
    const { limiter } = make()
    for (let i = 0; i < 3; i++) limiter.recordFailure('a')

    limiter.clear()

    expect(limiter.blockedFor('a')).toBe(0)
  })

  it('reads its options at call time when they are given as a function', () => {
    let limit = 2
    const limiter = new FailureLimiter(() => 1_000_000, () => ({ limit, windowMs: 60_000, blockMs: 30_000, maxEntries: 10 }))

    limiter.recordFailure('a')
    limit = 1
    limiter.recordFailure('b')

    expect(limiter.blockedFor('a')).toBe(0)
    expect(limiter.blockedFor('b')).toBe(30)
  })

  // A limiter created at module load must follow the clock the tests fake, like the rest of the code.
  it('reads the system clock on every call by default', () => {
    const limiter = new FailureLimiter(undefined, { limit: 1, windowMs: 60_000, blockMs: 600_000, maxEntries: 10 })
    vi.useFakeTimers()
    try {
      limiter.recordFailure('a')
      expect(limiter.blockedFor('a')).toBe(600)

      vi.advanceTimersByTime(600_001)

      expect(limiter.blockedFor('a')).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
