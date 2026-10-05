import { beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import net from 'net'
import { clearAuthCache } from '../middleware/auth'
import { clearSettingsRefreshes } from '../routes/settings'

// Default online mode for all tests: auth.test.ts overrides these per-suite as needed.
const DEFAULT_VALIDATION_SECRET = 'test-secret'

// supertest's `request(app)` listens on port 0 on all interfaces and then connects to 127.0.0.1.
// macOS may hand out a port that another program already holds on 127.0.0.1 alone, and then that
// program answers the test's request (a stray 404, 403 or empty body, in about 3% of runs). Bound
// to 127.0.0.1, the port is one nobody else has there.
//
// `_listen2` is where `listen` binds, and Node keeps the name for code that wraps it. Not `listen`
// with a host: that binds after a DNS lookup, and supertest reads the port as soon as it returns.
type Listen2 = (this: net.Server, address: string | null, port: number, addressType: number, ...rest: unknown[]) => void
const serverPrototype = net.Server.prototype as unknown as { _listen2: Listen2 }
const bindAsAsked = serverPrototype._listen2

beforeAll(() => {
  serverPrototype._listen2 = function (address, port, addressType, ...rest) {
    // Port 0 and no host: `listen(0)`. A host the test names itself is left alone.
    if (port === 0 && !address) return bindAsAsked.call(this, '127.0.0.1', 0, 4, ...rest)
    return bindAsAsked.call(this, address, port, addressType, ...rest)
  }
})

afterAll(() => {
  serverPrototype._listen2 = bindAsAsked
})

beforeEach(() => {
  clearAuthCache()
  clearSettingsRefreshes()

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
