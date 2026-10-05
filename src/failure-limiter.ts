import { envNumber } from './env'

interface Entry { failures: number; windowStart: number; blockedUntil: number }
export interface FailureLimiterOptions { limit: number; windowMs: number; blockMs: number; maxEntries: number }

/**
 * Counts events per address and blocks the address once `limit` of them fall inside one window.
 * By default the events are failed API-key checks: throttling all requests cannot tell a
 * key-guessing script from a busy, legitimate client; counting only failures can. In memory: one
 * process serves the API.
 */
export class FailureLimiter {
  private readonly entries = new Map<string, Entry>()

  /** `options` may be a function, so that limits taken from the environment are read on every call. */
  constructor(
    private readonly clock: () => number = () => Date.now(),
    private readonly options?: FailureLimiterOptions | (() => FailureLimiterOptions),
  ) {}

  private settings(): FailureLimiterOptions {
    if (typeof this.options === 'function') return this.options()
    return this.options ?? {
      limit: envNumber('KEY_FAILURE_LIMIT', 20),
      windowMs: envNumber('KEY_FAILURE_WINDOW_SEC', 60) * 1000,
      blockMs: envNumber('KEY_FAILURE_BLOCK_SEC', 600) * 1000,
      maxEntries: 50_000,
    }
  }

  /** Seconds this address stays blocked; 0 when it may proceed. */
  blockedFor(ip: string): number {
    const entry = this.entries.get(ip)
    if (!entry) return 0
    const left = entry.blockedUntil - this.clock()
    return left > 0 ? Math.ceil(left / 1000) : 0
  }

  recordFailure(ip: string): void {
    const { limit, windowMs, blockMs, maxEntries } = this.settings()
    const now = this.clock()
    let entry = this.entries.get(ip)
    if (!entry || now - entry.windowStart > windowMs) {
      entry = { failures: 0, windowStart: now, blockedUntil: entry?.blockedUntil ?? 0 }
    }
    entry.failures += 1
    if (entry.failures >= limit) entry.blockedUntil = now + blockMs
    this.entries.delete(ip)
    this.entries.set(ip, entry)
    // Oldest first (a Map keeps insertion order): rotating addresses cannot grow memory without bound.
    while (this.entries.size > maxEntries) this.entries.delete(this.entries.keys().next().value as string)
  }

  clear(): void {
    this.entries.clear()
  }

  size(): number {
    return this.entries.size
  }
}
