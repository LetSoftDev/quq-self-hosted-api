import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { authMiddleware } from './auth'

// Helpers to build mock req/res/next
function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    path: '/api/list',
    headers: {},
    query: {},
    ...overrides,
  } as any
}

function makeRes() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as any
  res.status.mockReturnValue(res)
  return res
}

// ──────────────────────────────────────────────────────────
// Hardcoded backend-pro URL
// ──────────────────────────────────────────────────────────
describe('authMiddleware — hardcoded backend-pro URL', () => {
  beforeEach(() => {
    delete process.env.VALIDATION_SECRET
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('skips auth for /health', () => {
    const req = makeReq({ path: '/health' })
    const res = makeRes()
    const next = vi.fn()
    authMiddleware(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('uses the hardcoded local Docker host URL', async () => {
    process.env.VALIDATION_SECRET = 'test-secret'
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      json: async () => ({ valid: true }),
    } as any)

    const req = makeReq({ headers: { 'x-api-key': 'qk_abc' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)
    expect(fetch).toHaveBeenCalledWith(
      'http://host.docker.internal:3001/validation/verify',
      expect.any(Object),
    )
    expect(next).toHaveBeenCalled()
  })

  it('returns 401 without x-api-key before calling validation', async () => {
    const req = makeReq({ headers: {} })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'API key required' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────
// Online mode
// ──────────────────────────────────────────────────────────
describe('authMiddleware — online mode', () => {
  const VALIDATION_API_URL = 'http://host.docker.internal:3001'
  const SECRET = 'test-secret'

  beforeEach(() => {
    process.env.VALIDATION_SECRET = SECRET
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.VALIDATION_SECRET
  })

  it('skips auth for /health', async () => {
    const req = makeReq({ path: '/health' })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns 401 immediately when x-api-key is absent (no network call)', async () => {
    const req = makeReq({ headers: {} })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'API key required' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('returns 503 when VALIDATION_SECRET is absent', async () => {
    delete process.env.VALIDATION_SECRET
    const req = makeReq({ headers: { 'x-api-key': 'qk_abc' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)
    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: 'Validation service unavailable' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('calls backend-pro with correct body and secret header', async () => {
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      json: async () => ({ valid: true }),
    } as any)

    const req = makeReq({
      headers: { 'x-api-key': 'qk_abc', 'origin': 'https://app.example.com' },
    })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)

    expect(fetch).toHaveBeenCalledWith(
      `${VALIDATION_API_URL}/validation/verify`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-validation-secret': SECRET,
        }),
        body: JSON.stringify({ apiKey: 'qk_abc', origin: 'https://app.example.com' }),
      }),
    )
    expect(next).toHaveBeenCalled()
  })

  it('uses empty string for origin when Origin header absent', async () => {
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      json: async () => ({ valid: true }),
    } as any)

    const req = makeReq({ headers: { 'x-api-key': 'qk_abc' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)

    const callBody = JSON.parse((fetch as any).mock.calls[0][1].body)
    expect(callBody.origin).toBe('')
  })

  it('returns 401 when backend-pro returns valid: false', async () => {
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      json: async () => ({ valid: false, reason: 'invalid_key' }),
    } as any)

    const req = makeReq({ headers: { 'x-api-key': 'qk_bad' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' })
    expect(next).not.toHaveBeenCalled()
  })

  it('returns 401 when backend-pro returns non-200 status (e.g. 401)', async () => {
    vi.mocked(fetch).mockResolvedValue({
      status: 401,
      json: async () => ({ valid: false, reason: 'invalid_key' }),
    } as any)

    const req = makeReq({ headers: { 'x-api-key': 'qk_bad' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' })
  })

  it('returns 503 when backend-pro returns 403 (misconfigured secret)', async () => {
    vi.mocked(fetch).mockResolvedValue({ status: 403 } as any)

    const req = makeReq({ headers: { 'x-api-key': 'qk_abc' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: 'Validation service unavailable' })
  })

  it('returns 503 when backend-pro returns 429 (rate limited)', async () => {
    vi.mocked(fetch).mockResolvedValue({ status: 429 } as any)

    const req = makeReq({ headers: { 'x-api-key': 'qk_abc' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: 'Validation service unavailable' })
  })

  it('returns 503 when backend-pro returns 500 (internal error)', async () => {
    vi.mocked(fetch).mockResolvedValue({ status: 500 } as any)

    const req = makeReq({ headers: { 'x-api-key': 'qk_abc' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: 'Validation service unavailable' })
  })

  it('returns 503 on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'))

    const req = makeReq({ headers: { 'x-api-key': 'qk_abc' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: 'Validation service unavailable' })
  })

  it('returns 503 when fetch times out (AbortError)', async () => {
    vi.mocked(fetch).mockRejectedValue(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }))

    const req = makeReq({ headers: { 'x-api-key': 'qk_abc' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(503)
    expect(res.json).toHaveBeenCalledWith({ error: 'Validation service unavailable' })
  })

  it('ignores ?api_key= query param in online mode', async () => {
    const req = makeReq({ headers: {}, query: { api_key: 'qk_abc' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)

    expect(res.status).toHaveBeenCalledWith(401)
    expect(res.json).toHaveBeenCalledWith({ error: 'API key required' })
    expect(fetch).not.toHaveBeenCalled()
  })

  describe('caching', () => {
    it('calls backend-pro once and uses cache on second request', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 200,
        json: async () => ({ valid: true }),
      } as any)

      const req1 = makeReq({ headers: { 'x-api-key': 'qk_cached', 'origin': 'https://app.com' } })
      const req2 = makeReq({ headers: { 'x-api-key': 'qk_cached', 'origin': 'https://app.com' } })
      const res1 = makeRes()
      const res2 = makeRes()
      const next1 = vi.fn()
      const next2 = vi.fn()

      await authMiddleware(req1, res1, next1)
      await authMiddleware(req2, res2, next2)

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(next1).toHaveBeenCalled()
      expect(next2).toHaveBeenCalled()
    })

    it('does not cache failed validations', async () => {
      vi.mocked(fetch).mockResolvedValue({
        status: 401,
        json: async () => ({ valid: false }),
      } as any)

      const makeFailReq = () =>
        makeReq({ headers: { 'x-api-key': 'qk_fail_nocache', 'origin': 'https://bad.com' } })

      const next1 = vi.fn()
      const next2 = vi.fn()
      await authMiddleware(makeFailReq(), makeRes(), next1)
      await authMiddleware(makeFailReq(), makeRes(), next2)

      expect(fetch).toHaveBeenCalledTimes(2)
    })
  })
})
