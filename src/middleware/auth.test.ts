import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { authMiddleware, clearAuthCache, updateCachedProjectImageSettings } from './auth'

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
    setHeader: vi.fn(),
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

  it('uses the hardcoded QuqManager platform API URL', async () => {
    process.env.VALIDATION_SECRET = 'test-secret'
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      json: async () => ({
        valid: true,
        settings: {
          createImagePreviews: false,
          optimizeImages: true,
        },
      }),
    } as any)

    const req = makeReq({ headers: { 'x-api-key': 'qk_abc' } })
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)
    expect(fetch).toHaveBeenCalledWith(
      'https://qapi.letsoft.co/validation/verify',
      expect.any(Object),
    )
    expect((req as any).quqProject.settings).toEqual({
      allowFileIndexing: false,
      canOptimizeImages: false,
      createImagePreviews: false,
      effectiveOptimizeImages: false,
      optimizeImages: true,
      plan: 'free',
    })
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
  const VALIDATION_API_URL = 'https://qapi.letsoft.co'
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
        json: async () => ({
          valid: true,
          settings: {
            createImagePreviews: false,
            optimizeImages: false,
          },
        }),
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
      expect((req2 as any).quqProject.settings).toEqual({
        allowFileIndexing: false,
        canOptimizeImages: false,
        createImagePreviews: false,
        effectiveOptimizeImages: false,
        optimizeImages: false,
        plan: 'free',
      })
    })

    it('remembers a refused key for a minute, then asks again', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(fetch).mockResolvedValue({ status: 401, json: async () => ({ valid: false }) } as any)
        const makeFailReq = () =>
          makeReq({ headers: { 'x-api-key': 'qk_fail', 'origin': 'https://bad.com' } })

        const res1 = makeRes()
        const res2 = makeRes()
        await authMiddleware(makeFailReq(), res1, vi.fn())
        await authMiddleware(makeFailReq(), res2, vi.fn())

        expect(fetch).toHaveBeenCalledTimes(1)
        expect(res2.status).toHaveBeenCalledWith(401)

        vi.advanceTimersByTime(61_000)
        await authMiddleware(makeFailReq(), makeRes(), vi.fn())

        expect(fetch).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not remember a validation service outage for the key: it is asked about again after the back-off', async () => {
      vi.useFakeTimers()
      try {
        vi.mocked(fetch).mockResolvedValue({ status: 500, json: async () => ({}) } as any)
        const failing = () => makeReq({ headers: { 'x-api-key': 'qk_outage' } })

        await authMiddleware(failing(), makeRes(), vi.fn())
        vi.advanceTimersByTime(16_000)
        await authMiddleware(failing(), makeRes(), vi.fn())

        expect(fetch).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})

describe('authMiddleware — failures per address', () => {
  beforeEach(() => {
    process.env.VALIDATION_SECRET = 'test-secret'
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const valid = JSON.parse(init.body).apiKey.startsWith('qk_good')
      return { status: valid ? 200 : 401, json: async () => ({ valid }) }
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const from = (ip: string, apiKey?: string) =>
    makeReq({ ip, headers: apiKey ? { 'x-api-key': apiKey } : {} })

  const fail = async (ip: string, times: number) => {
    for (let i = 0; i < times; i++) await authMiddleware(from(ip, `qk_bad_${i}`), makeRes(), vi.fn())
  }

  it('answers 429 with Retry-After once an address has failed 20 times, without asking the service', async () => {
    await fail('203.0.113.9', 20)
    vi.mocked(fetch).mockClear()

    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(from('203.0.113.9', 'qk_bad_again'), res, next)

    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.json).toHaveBeenCalledWith({ error: 'Too many failed requests', reason: 'rate_limited' })
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '600')
    expect(fetch).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('counts a missing key and a repeat of a remembered refusal as failures', async () => {
    for (let i = 0; i < 10; i++) await authMiddleware(from('203.0.113.10'), makeRes(), vi.fn())
    for (let i = 0; i < 10; i++) await authMiddleware(from('203.0.113.10', 'qk_same_bad'), makeRes(), vi.fn())

    const res = makeRes()
    await authMiddleware(from('203.0.113.10', 'qk_other'), res, vi.fn())

    expect(res.status).toHaveBeenCalledWith(429)
  })

  it('does not block another address', async () => {
    await fail('203.0.113.11', 20)

    const next = vi.fn()
    await authMiddleware(from('203.0.113.12', 'qk_good_1'), makeRes(), next)

    expect(next).toHaveBeenCalled()
  })

  it('keeps serving a key that is already known to be valid from a blocked address', async () => {
    const next = vi.fn()
    await authMiddleware(from('203.0.113.13', 'qk_good_2'), makeRes(), next)
    await fail('203.0.113.13', 20)

    await authMiddleware(from('203.0.113.13', 'qk_good_2'), makeRes(), next)

    expect(next).toHaveBeenCalledTimes(2)
  })

  it('does not count a validation service outage as a failure', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(fetch).mockResolvedValue({ status: 500, json: async () => ({}) } as any)
      await fail('203.0.113.14', 25)
      vi.mocked(fetch).mockResolvedValue({ status: 200, json: async () => ({ valid: true }) } as any)
      // Past the back-off that the outage started, well inside the 10 minutes a block would last.
      vi.advanceTimersByTime(16_000)

      const next = vi.fn()
      await authMiddleware(from('203.0.113.14', 'qk_good_3'), makeRes(), next)

      expect(next).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})

// ──────────────────────────────────────────────────────────
// Outbound validation calls are bounded, live sessions are not locked out
// ──────────────────────────────────────────────────────────
describe('authMiddleware — bounded validation calls', () => {
  const MINUTE = 60_000

  beforeEach(() => {
    process.env.VALIDATION_SECRET = 'test-secret'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.VALIDATION_ATTEMPT_LIMIT
    delete process.env.KEY_FAILURE_LIMIT
    delete process.env.KEY_FAILURE_BLOCK_SEC
  })

  const central = (status: number, body: Record<string, unknown> = {}) =>
    vi.mocked(fetch).mockResolvedValue({ status, json: async () => body } as any)

  // Answers by key, so that good and bad keys can be mixed in one test.
  const centralByKey = () =>
    vi.mocked(fetch).mockImplementation((async (_url: string, init: { body: string }) => {
      const valid = JSON.parse(init.body).apiKey.startsWith('qk_good')
      return { status: valid ? 200 : 401, json: async () => ({ valid }) }
    }) as any)

  const request = (apiKey: string, origin = 'https://site.example', ip = '203.0.113.50') =>
    makeReq({ ip, headers: { 'x-api-key': apiKey, origin } })

  const run = async (req: any) => {
    const res = makeRes()
    const next = vi.fn()
    await authMiddleware(req, res, next)
    return { req, res, next }
  }

  describe('a key of another project (403 from the validation service)', () => {
    it('is asked about once and answered 503 both times', async () => {
      central(403)

      const first = await run(request('qk_foreign'))
      const second = await run(request('qk_foreign'))

      expect(fetch).toHaveBeenCalledTimes(1)
      for (const { res, next } of [first, second]) {
        expect(res.status).toHaveBeenCalledWith(503)
        expect(res.json).toHaveBeenCalledWith({ error: 'Validation service unavailable' })
        expect(next).not.toHaveBeenCalled()
      }
    })

    it('counts against the address: after 20 of them a new key gets 429 without a call, a known pair still passes', async () => {
      central(200, { valid: true })
      await run(request('qk_good_known'))
      central(403)
      for (let i = 0; i < 20; i++) await run(request(`qk_foreign_${i}`))
      vi.mocked(fetch).mockClear()
      central(200, { valid: true })

      const unknown = await run(request('qk_good_new'))
      const known = await run(request('qk_good_known'))

      expect(unknown.res.status).toHaveBeenCalledWith(429)
      expect(unknown.res.json).toHaveBeenCalledWith({ error: 'Too many failed requests', reason: 'rate_limited' })
      expect(unknown.res.setHeader).toHaveBeenCalledWith('Retry-After', '600')
      expect(unknown.next).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
      expect(known.next).toHaveBeenCalled()
      expect(known.res.status).not.toHaveBeenCalled()
    })

    it('counts a repeat of the remembered answer too', async () => {
      central(403)
      for (let i = 0; i < 20; i++) await run(request('qk_foreign'))
      expect(fetch).toHaveBeenCalledTimes(1)
      central(200, { valid: true })

      const { res, next } = await run(request('qk_good_new'))

      expect(res.status).toHaveBeenCalledWith(429)
      expect(next).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('does not block another address', async () => {
      central(403)
      for (let i = 0; i < 20; i++) await run(request(`qk_foreign_${i}`))
      central(200, { valid: true })

      const { next } = await run(request('qk_good_new', 'https://site.example', '203.0.113.51'))

      expect(next).toHaveBeenCalled()
    })

    it('drops a key that used to be valid instead of asking on every request', async () => {
      vi.useFakeTimers()
      try {
        central(200, { valid: true })
        await run(request('qk_moved'))
        vi.advanceTimersByTime(16 * MINUTE)
        central(403)

        const first = await run(request('qk_moved'))
        const second = await run(request('qk_moved'))

        expect(fetch).toHaveBeenCalledTimes(2)
        expect(first.res.status).toHaveBeenCalledWith(503)
        expect(second.res.status).toHaveBeenCalledWith(503)
        expect(second.next).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('the Origin is matched by hostname', () => {
    it('keeps one entry for every scheme and port of a site', async () => {
      central(200, { valid: true })

      const a = await run(request('qk_site', 'https://site.example'))
      const b = await run(request('qk_site', 'https://site.example:1001'))
      const c = await run(request('qk_site', 'http://SITE.example:1002/'))

      expect(fetch).toHaveBeenCalledTimes(1)
      expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string).origin).toBe('https://site.example')
      for (const { next } of [a, b, c]) expect(next).toHaveBeenCalled()
      expect(c.req.quqProject.origin).toBe('http://SITE.example:1002/')

      await run(request('qk_site', 'https://other.example'))

      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('updates the cached settings through any origin of the site', async () => {
      central(200, { valid: true, settings: { createImagePreviews: true } })
      await run(request('qk_site', 'https://site.example'))

      const { req } = await run(request('qk_site', 'https://site.example'))
      updateCachedProjectImageSettings('qk_site', {
        ...req.quqProject.settings,
        createImagePreviews: false,
      })
      const after = await run(request('qk_site', 'https://site.example:1001'))

      expect(after.req.quqProject.settings.createImagePreviews).toBe(false)
      expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('updates the cached settings of every origin of the key, and of no other key', async () => {
      central(200, { valid: true, settings: { createImagePreviews: true } })
      const { req } = await run(request('qk_site', 'https://a.example'))
      await run(request('qk_site', 'https://b.example'))
      await run(request('qk_site_2', 'https://a.example'))

      updateCachedProjectImageSettings('qk_site', { ...req.quqProject.settings, createImagePreviews: false })

      expect((await run(request('qk_site', 'https://a.example'))).req.quqProject.settings.createImagePreviews).toBe(false)
      expect((await run(request('qk_site', 'https://b.example'))).req.quqProject.settings.createImagePreviews).toBe(false)
      expect((await run(request('qk_site_2', 'https://a.example'))).req.quqProject.settings.createImagePreviews).toBe(true)
      expect(fetch).toHaveBeenCalledTimes(3)
    })

    // `site.example` is not a URL, so the validation service refuses it. It must not be mistaken
    // for the hostname of `https://site.example`: neither served from that entry nor able to evict it.
    it('does not let a bare string that spells the hostname share or poison the site entry', async () => {
      vi.mocked(fetch).mockImplementation((async (_url: string, init: { body: string }) => {
        const valid = JSON.parse(init.body).origin.startsWith('https://')
        return { status: valid ? 200 : 400, json: async () => ({ valid }) }
      }) as any)
      await run(request('qk_site', 'https://site.example'))

      const bare = await run(request('qk_site', 'site.example'))
      const site = await run(request('qk_site', 'https://site.example'))

      expect(bare.res.status).toHaveBeenCalledWith(401)
      expect(bare.next).not.toHaveBeenCalled()
      expect(site.next).toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledTimes(2)
    })
  })

  describe('over-long input', () => {
    it('refuses a key longer than 256 characters without asking the service', async () => {
      const { res, next } = await run(request('k'.repeat(257)))

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' })
      expect(next).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('refuses an Origin longer than 2048 characters without asking the service', async () => {
      const { res, next } = await run(request('qk_good', `https://${'a'.repeat(2048)}.example`))

      expect(res.status).toHaveBeenCalledWith(401)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid API key' })
      expect(next).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('accepts a key of exactly 256 characters and an Origin of exactly 2048', async () => {
      central(200, { valid: true })
      const origin = `https://site.example/${'a'.repeat(2048)}`.slice(0, 2048)

      const { next } = await run(request('k'.repeat(256), origin))

      expect(next).toHaveBeenCalled()
    })

    it('counts as a failure of the address', async () => {
      for (let i = 0; i < 10; i++) await run(request('k'.repeat(257)))
      for (let i = 0; i < 10; i++) await run(request('qk_good', `https://${'a'.repeat(2048)}.example`))

      const { res } = await run(request('qk_good'))

      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.json).toHaveBeenCalledWith({ error: 'Too many failed requests', reason: 'rate_limited' })
      expect(fetch).not.toHaveBeenCalled()
    })
  })

  describe('concurrent requests', () => {
    it('shares one validation between requests with the same key', async () => {
      central(200, { valid: true })

      const results = await Promise.all(Array.from({ length: 10 }, () => run(request('qk_good'))))

      expect(fetch).toHaveBeenCalledTimes(1)
      for (const { next } of results) expect(next).toHaveBeenCalled()
    })

    it('does not charge the attempt budget for joining a validation in flight', async () => {
      process.env.VALIDATION_ATTEMPT_LIMIT = '1'
      central(200, { valid: true })

      const results = await Promise.all(Array.from({ length: 10 }, () => run(request('qk_good'))))

      for (const { next } of results) expect(next).toHaveBeenCalled()
    })

    it('lets at most 60 of 300 distinct bad keys from one address reach the service', async () => {
      centralByKey()

      const results = await Promise.all(
        Array.from({ length: 300 }, (_, i) => run(request(`qk_bad_${i}`))),
      )

      expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(60)
      const limited = results.filter(({ res }) => res.status.mock.calls[0][0] === 429)
      expect(limited).toHaveLength(300 - vi.mocked(fetch).mock.calls.length)
      for (const { res, next } of limited) {
        expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^[1-9]\d*$/))
        expect(next).not.toHaveBeenCalled()
      }
    })
  })

  describe('validation attempts per address', () => {
    it('answers 429 to the 61st new key in a minute without asking the service', async () => {
      // 403 is not an outage, and the block for failures is moved out of the way: only the attempt
      // budget can stop the 61st.
      process.env.KEY_FAILURE_LIMIT = '1000'
      central(403)
      for (let i = 0; i < 60; i++) await run(request(`qk_any_${i}`))
      expect(fetch).toHaveBeenCalledTimes(60)

      const { res, next } = await run(request('qk_any_60'))

      expect(res.status).toHaveBeenCalledWith(429)
      expect(res.json).toHaveBeenCalledWith({ error: 'Too many requests', reason: 'rate_limited' })
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^[1-9]\d*$/))
      expect(next).not.toHaveBeenCalled()
      expect(fetch).toHaveBeenCalledTimes(60)

      const other = await run(request('qk_any_60', 'https://site.example', '203.0.113.51'))

      expect(other.res.status).toHaveBeenCalledWith(503)
      expect(fetch).toHaveBeenCalledTimes(61)
    })

    it('takes the limit from VALIDATION_ATTEMPT_LIMIT', async () => {
      process.env.VALIDATION_ATTEMPT_LIMIT = '2'
      central(403)
      await run(request('qk_any_0'))
      await run(request('qk_any_1'))

      const { res } = await run(request('qk_any_2'))

      expect(res.status).toHaveBeenCalledWith(429)
      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('gives the address a new budget a minute later', async () => {
      vi.useFakeTimers()
      try {
        process.env.VALIDATION_ATTEMPT_LIMIT = '2'
        central(403)
        for (let i = 0; i < 3; i++) await run(request(`qk_any_${i}`))
        vi.advanceTimersByTime(61_000)

        const { res } = await run(request('qk_any_3'))

        expect(res.status).toHaveBeenCalledWith(503)
        expect(fetch).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // One address is held to 60 new keys a minute; many addresses together are not held by that, and
  // the validation service limits this whole server by its address.
  describe('new keys from all addresses together', () => {
    const ipOf = (i: number) => `198.51.${(i >> 8) & 255}.${i & 255}`
    const foreign = (i: number, address = i) => request(`qk_foreign_${i}`, 'https://site.example', ipOf(address))

    const expectHeldBack = ({ res, next }: Awaited<ReturnType<typeof run>>) => {
      expect(res.status).toHaveBeenCalledWith(503)
      expect(res.json).toHaveBeenCalledWith({ error: 'Validation service unavailable' })
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.stringMatching(/^[1-9]\d*$/))
      expect(next).not.toHaveBeenCalled()
    }

    afterEach(() => {
      delete process.env.VALIDATION_GLOBAL_LIMIT
    })

    // 20 each: the 20th such key blocks its address, so more of them would be answered 429.
    it('sends at most 300 of 3000 to the service in a minute: 150 addresses, 20 keys of another project each', async () => {
      central(403)
      const results: Awaited<ReturnType<typeof run>>[] = []
      for (let address = 0; address < 150; address++) {
        for (let key = 0; key < 20; key++) results.push(await run(foreign(address * 20 + key, address)))
      }

      expect(fetch).toHaveBeenCalledTimes(300)
      for (const result of results.slice(300)) expectHeldBack(result)
    })

    it('does not let requests that arrive together go over the limit', async () => {
      process.env.VALIDATION_GLOBAL_LIMIT = '25'
      central(403)

      const results = await Promise.all(Array.from({ length: 200 }, (_, i) => run(foreign(i))))

      expect(fetch).toHaveBeenCalledTimes(25)
      const heldBack = results.filter(({ res }) => res.setHeader.mock.calls.length > 0)
      expect(heldBack).toHaveLength(175)
      heldBack.forEach(expectHeldBack)
    })

    it('takes the limit from VALIDATION_GLOBAL_LIMIT and says when the window ends', async () => {
      vi.useFakeTimers()
      try {
        process.env.VALIDATION_GLOBAL_LIMIT = '2'
        central(200, { valid: true })
        expect((await run(foreign(0))).next).toHaveBeenCalled()
        vi.advanceTimersByTime(20_000)
        expect((await run(foreign(1))).next).toHaveBeenCalled()

        const third = await run(foreign(2))

        expectHeldBack(third)
        expect(third.res.setHeader).toHaveBeenCalledWith('Retry-After', '40')
        expect(fetch).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('starts a new window a minute later', async () => {
      vi.useFakeTimers()
      try {
        process.env.VALIDATION_GLOBAL_LIMIT = '2'
        central(200, { valid: true })
        for (let i = 0; i < 3; i++) await run(foreign(i))
        vi.advanceTimersByTime(60_000)

        const { next } = await run(foreign(3))

        expect(next).toHaveBeenCalled()
        expect(fetch).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not charge the address for a request it held back', async () => {
      vi.useFakeTimers()
      try {
        process.env.VALIDATION_GLOBAL_LIMIT = '1'
        process.env.VALIDATION_ATTEMPT_LIMIT = '1'
        central(200, { valid: true })
        await run(foreign(0))
        vi.advanceTimersByTime(50_000)
        expectHeldBack(await run(foreign(1)))
        // A new window for everyone; an attempt charged ten seconds ago would still block address 1.
        vi.advanceTimersByTime(10_000)

        const { next } = await run(foreign(1))

        expect(next).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('does not count joining a validation in flight', async () => {
      process.env.VALIDATION_GLOBAL_LIMIT = '1'
      central(200, { valid: true })

      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => run(request('qk_good', 'https://site.example', ipOf(i)))))

      expect(fetch).toHaveBeenCalledTimes(1)
      for (const { next } of results) expect(next).toHaveBeenCalled()
    })

    it('still serves the keys it holds, and revalidates a known one', async () => {
      vi.useFakeTimers()
      try {
        process.env.VALIDATION_GLOBAL_LIMIT = '2'
        centralByKey()
        await run(request('qk_good_known'))
        vi.advanceTimersByTime(14 * MINUTE)
        await run(request('qk_good_fresh'))
        vi.advanceTimersByTime(2 * MINUTE)
        await run(foreign(0))
        await run(foreign(1))
        expectHeldBack(await run(foreign(2)))
        expect(fetch).toHaveBeenCalledTimes(4)

        const fresh = await run(request('qk_good_fresh'))
        const known = await run(request('qk_good_known'))

        expect(fresh.next).toHaveBeenCalled()
        expect(known.next).toHaveBeenCalled()
        expect(known.res.status).not.toHaveBeenCalled()
        // The known pair was asked about: its revalidation is not held back.
        expect(fetch).toHaveBeenCalledTimes(5)
      } finally {
        vi.useRealTimers()
      }
    })

    it('is forgotten by clearAuthCache', async () => {
      process.env.VALIDATION_GLOBAL_LIMIT = '1'
      central(200, { valid: true })
      await run(foreign(0))
      expectHeldBack(await run(foreign(1)))

      clearAuthCache()

      expect((await run(foreign(1))).next).toHaveBeenCalled()
    })
  })

  // During an outage every new key would otherwise cost a call that fails, or hangs for 5 seconds.
  describe('while the validation service is failing', () => {
    const expectHeldBack = ({ res, next }: Awaited<ReturnType<typeof run>>, retryAfter: string) => {
      expect(res.status).toHaveBeenCalledWith(503)
      expect(res.json).toHaveBeenCalledWith({ error: 'Validation service unavailable' })
      expect(res.setHeader).toHaveBeenCalledWith('Retry-After', retryAfter)
      expect(next).not.toHaveBeenCalled()
    }

    it.each([
      ['a 500', () => central(500)],
      ['a 503', () => central(503)],
      ['a 429', () => central(429)],
      ['a network error', () => vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'))],
      ['a timeout', () => vi.mocked(fetch).mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))],
    ])('sends no new key for 15 seconds after %s, then asks again', async (_name, breakCentral) => {
      vi.useFakeTimers()
      try {
        breakCentral()
        const first = await run(request('qk_good_a'))
        expect(first.res.status).toHaveBeenCalledWith(503)
        expect(fetch).toHaveBeenCalledTimes(1)
        central(200, { valid: true })

        vi.advanceTimersByTime(1000)
        expectHeldBack(await run(request('qk_good_a')), '14')
        expectHeldBack(await run(request('qk_good_b', 'https://site.example', '203.0.113.60')), '14')
        vi.advanceTimersByTime(13_999)
        expectHeldBack(await run(request('qk_good_b')), '1')
        expect(fetch).toHaveBeenCalledTimes(1)

        vi.advanceTimersByTime(1)
        const after = await run(request('qk_good_b'))

        expect(after.next).toHaveBeenCalled()
        expect(fetch).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it.each([
      ['a 500', () => central(500)],
      ['a 429', () => central(429)],
      ['a network error', () => vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'))],
      ['a timeout', () => vi.mocked(fetch).mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }))],
    ])('says when to retry after %s, to the request that asked and to those that waited for it', async (_name, breakCentral) => {
      breakCentral()

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => run(request('qk_good_a', 'https://site.example', `203.0.113.${70 + i}`))),
      )

      expect(fetch).toHaveBeenCalledTimes(1)
      for (const result of results) expectHeldBack(result, '15')
    })

    it('says when to retry for a pair whose entry expired too long ago to be served', async () => {
      vi.useFakeTimers()
      try {
        central(200, { valid: true })
        await run(request('qk_good'))
        vi.advanceTimersByTime(80 * MINUTE)
        central(500)

        expectHeldBack(await run(request('qk_good')), '15')
      } finally {
        vi.useRealTimers()
      }
    })

    // Retrying cannot help in these two: the header would only invite requests that fail again.
    it('says nothing about retrying when VALIDATION_SECRET is missing', async () => {
      delete process.env.VALIDATION_SECRET

      const { res } = await run(request('qk_good'))

      expect(res.status).toHaveBeenCalledWith(503)
      expect(res.setHeader).not.toHaveBeenCalled()
    })

    it('says nothing about retrying for a key of another project', async () => {
      central(403)

      const first = await run(request('qk_foreign'))
      const remembered = await run(request('qk_foreign'))

      for (const { res } of [first, remembered]) {
        expect(res.status).toHaveBeenCalledWith(503)
        expect(res.setHeader).not.toHaveBeenCalled()
      }
    })

    it.each([
      ['a refused key', () => central(401, { valid: false })],
      ['a key of another project', () => central(403)],
    ])('goes on asking after %s: that is an answer', async (_name, answer) => {
      answer()
      await run(request('qk_bad_a'))

      await run(request('qk_bad_b'))

      expect(fetch).toHaveBeenCalledTimes(2)
    })

    it('counts neither a failure nor an attempt for a request it held back', async () => {
      vi.useFakeTimers()
      try {
        process.env.VALIDATION_ATTEMPT_LIMIT = '3'
        central(500)
        for (let i = 0; i < 30; i++) await run(request(`qk_good_${i}`))
        expect(fetch).toHaveBeenCalledTimes(1)
        central(200, { valid: true })
        vi.advanceTimersByTime(15_000)

        const { next } = await run(request('qk_good_0'))

        expect(next).toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('serves a known pair from its stale entry without asking', async () => {
      vi.useFakeTimers()
      try {
        central(200, { valid: true, settings: { createImagePreviews: false } })
        await run(request('qk_good'))
        vi.advanceTimersByTime(16 * MINUTE)
        central(500)
        await run(request('qk_new'))
        expect(fetch).toHaveBeenCalledTimes(2)

        const during = await run(request('qk_good'))

        expect(during.next).toHaveBeenCalled()
        expect(during.res.status).not.toHaveBeenCalled()
        expect(during.req.quqProject.settings.createImagePreviews).toBe(false)
        expect(fetch).toHaveBeenCalledTimes(2)

        // After the back-off the known pair is revalidated as before.
        vi.advanceTimersByTime(15_000)
        central(200, { valid: true, settings: { createImagePreviews: true } })
        const after = await run(request('qk_good'))

        expect(after.req.quqProject.settings.createImagePreviews).toBe(true)
        expect(fetch).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('backs off for new keys when the revalidation of a known pair fails', async () => {
      vi.useFakeTimers()
      try {
        central(200, { valid: true })
        await run(request('qk_good'))
        vi.advanceTimersByTime(16 * MINUTE)
        central(500)
        expect((await run(request('qk_good'))).next).toHaveBeenCalled()
        expect(fetch).toHaveBeenCalledTimes(2)

        expectHeldBack(await run(request('qk_new')), '15')

        expect(fetch).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })

    it('is forgotten by clearAuthCache', async () => {
      central(500)
      await run(request('qk_good_a'))
      central(200, { valid: true })

      clearAuthCache()

      expect((await run(request('qk_good_b'))).next).toHaveBeenCalled()
    })
  })

  describe('a key that was valid a moment ago', () => {
    it('is revalidated from an address that is blocked for failures', async () => {
      vi.useFakeTimers()
      try {
        // Longer than the 16 minutes below: the block must still be in force when the entry expires.
        process.env.KEY_FAILURE_BLOCK_SEC = '3600'
        centralByKey()
        await run(request('qk_good'))
        for (let i = 0; i < 20; i++) await run(request(`qk_bad_${i}`))
        expect((await run(request('qk_bad_again'))).res.status).toHaveBeenCalledWith(429)
        vi.mocked(fetch).mockClear()
        vi.advanceTimersByTime(16 * MINUTE)

        const { res, next } = await run(request('qk_good'))

        expect(next).toHaveBeenCalled()
        expect(res.status).not.toHaveBeenCalled()
        expect(fetch).toHaveBeenCalledTimes(1)
      } finally {
        vi.useRealTimers()
      }
    })

    it('is revalidated from an address that has used up its attempts', async () => {
      vi.useFakeTimers()
      try {
        process.env.VALIDATION_ATTEMPT_LIMIT = '1'
        centralByKey()
        await run(request('qk_good'))
        vi.advanceTimersByTime(16 * MINUTE)
        await run(request('qk_bad_0'))
        expect((await run(request('qk_bad_1'))).res.status).toHaveBeenCalledWith(429)

        const { next } = await run(request('qk_good'))

        expect(next).toHaveBeenCalled()
        expect(fetch).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it('is served from the stale entry while the validation service is down', async () => {
      vi.useFakeTimers()
      try {
        central(200, { valid: true, settings: { createImagePreviews: false } })
        await run(request('qk_good'))
        vi.advanceTimersByTime(16 * MINUTE)
        central(500)

        const first = await run(request('qk_good'))

        expect(first.next).toHaveBeenCalled()
        expect(first.res.status).not.toHaveBeenCalled()
        expect(first.req.quqProject.settings.createImagePreviews).toBe(false)
        expect(fetch).toHaveBeenCalledTimes(2)

        // The service is not asked again for a minute: the stale entry answers directly.
        vi.advanceTimersByTime(10_000)
        const second = await run(request('qk_good'))

        expect(second.next).toHaveBeenCalled()
        expect(second.req.quqProject.settings.createImagePreviews).toBe(false)
        expect(fetch).toHaveBeenCalledTimes(2)

        vi.advanceTimersByTime(61_000)
        central(200, { valid: true, settings: { createImagePreviews: true } })
        const third = await run(request('qk_good'))
        const fourth = await run(request('qk_good'))

        expect(third.next).toHaveBeenCalled()
        expect(third.req.quqProject.settings.createImagePreviews).toBe(true)
        expect(fourth.next).toHaveBeenCalled()
        expect(fetch).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })

    it.each([
      ['a 429', () => vi.mocked(fetch).mockResolvedValue({ status: 429 } as any)],
      ['a network error', () => vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'))],
    ])('is served from the stale entry on %s as well', async (_name, breakCentral) => {
      vi.useFakeTimers()
      try {
        central(200, { valid: true })
        await run(request('qk_good'))
        vi.advanceTimersByTime(16 * MINUTE)
        breakCentral()

        const { next, res } = await run(request('qk_good'))

        expect(next).toHaveBeenCalled()
        expect(res.status).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('is not served from an entry that expired more than an hour ago', async () => {
      vi.useFakeTimers()
      try {
        central(200, { valid: true })
        await run(request('qk_good'))
        vi.advanceTimersByTime(80 * MINUTE)
        central(500)

        const { res, next } = await run(request('qk_good'))

        expect(res.status).toHaveBeenCalledWith(503)
        expect(res.json).toHaveBeenCalledWith({ error: 'Validation service unavailable' })
        expect(next).not.toHaveBeenCalled()
      } finally {
        vi.useRealTimers()
      }
    })

    it('stops working when the validation service refuses it, even if the service then goes down', async () => {
      vi.useFakeTimers()
      try {
        central(200, { valid: true })
        await run(request('qk_good'))
        vi.advanceTimersByTime(16 * MINUTE)
        central(200, { valid: false })

        const revoked = await run(request('qk_good'))

        expect(revoked.res.status).toHaveBeenCalledWith(401)
        expect(revoked.res.json).toHaveBeenCalledWith({ error: 'Invalid API key' })
        expect(revoked.next).not.toHaveBeenCalled()

        // Past the minute the refusal is remembered for, so that the service is asked again.
        vi.advanceTimersByTime(61_000)
        central(500)
        const after = await run(request('qk_good'))

        expect(after.res.status).toHaveBeenCalledWith(503)
        expect(after.next).not.toHaveBeenCalled()
        expect(fetch).toHaveBeenCalledTimes(3)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('the cache of valid keys', () => {
    const ipOf = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`
    const validate = (i: number) => run(request(`qk_good_${i}`, 'https://site.example', ipOf(i)))

    // These tests validate 10,000 new keys at once: far more than the server sends in a minute.
    beforeEach(() => {
      process.env.VALIDATION_GLOBAL_LIMIT = '1000000'
    })

    afterEach(() => {
      delete process.env.VALIDATION_GLOBAL_LIMIT
    })

    it('holds at most 10,000 entries, dropping the oldest', async () => {
      central(200, { valid: true })
      for (let i = 0; i <= 10_000; i++) await validate(i)
      expect(fetch).toHaveBeenCalledTimes(10_001)

      await validate(10_000)
      await validate(1)
      expect(fetch).toHaveBeenCalledTimes(10_001)

      await validate(0)
      expect(fetch).toHaveBeenCalledTimes(10_002)
    })

    it('treats a revalidated key as the newest', async () => {
      vi.useFakeTimers()
      try {
        central(200, { valid: true })
        await validate(0)
        vi.advanceTimersByTime(16 * MINUTE)
        for (let i = 1; i < 10_000; i++) await validate(i)
        await validate(0)
        await validate(10_000)
        expect(fetch).toHaveBeenCalledTimes(10_002)

        await validate(0)

        expect(fetch).toHaveBeenCalledTimes(10_002)
      } finally {
        vi.useRealTimers()
      }
    })
  })
})
