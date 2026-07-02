import { beforeEach, afterEach, vi } from 'vitest'
import { clearAuthCache } from '../middleware/auth'

// Default online mode for all tests: auth.test.ts overrides these per-suite as needed.
const DEFAULT_VALIDATION_SECRET = 'test-secret'

beforeEach(() => {
  clearAuthCache()

  process.env.VALIDATION_SECRET = DEFAULT_VALIDATION_SECRET

  // Default fetch stub: approve any valid x-api-key (route tests use x-api-key: 'test-key').
  // auth.test.ts overrides this stub in its own beforeEach.
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    status: 200,
    json: async () => ({ valid: true }),
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.VALIDATION_SECRET
})
