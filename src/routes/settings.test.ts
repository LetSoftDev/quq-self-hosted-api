import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { settingsRouter } from './settings'

describe('Settings Router', () => {
  let app: express.Application

  beforeEach(() => {
    app = express()
    app.use(express.json())
    app.use('/api', settingsRouter)
  })

  afterEach(() => {
    delete process.env.VALIDATION_SECRET
  })

  it('loads project settings from backend-pro through validation secret', async () => {
    ;(fetch as any)
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          valid: true,
          settings: {
            createImagePreviews: true,
            optimizeImages: true,
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          createImagePreviews: false,
          optimizeImages: true,
        }),
      })

    const res = await request(app)
      .get('/api/settings')
      .set('x-api-key', 'qk_test')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      canOptimizeImages: false,
      allowFileIndexing: false,
      createImagePreviews: false,
      effectiveOptimizeImages: false,
      optimizeImages: true,
      plan: 'free',
    })
    expect(fetch).toHaveBeenLastCalledWith(
      'https://qapi.letsoft.co/validation/project-settings?apiKey=qk_test',
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-validation-secret': 'test-secret' }),
      }),
    )
  })

  it('patches project settings in backend-pro and returns normalized settings', async () => {
    ;(fetch as any)
      .mockResolvedValueOnce({
        status: 200,
        json: async () => ({ valid: true }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          createImagePreviews: false,
          optimizeImages: false,
          allowFileIndexing: true,
        }),
      })

    const res = await request(app)
      .patch('/api/settings')
      .set('x-api-key', 'qk_test')
      .send({ createImagePreviews: false, optimizeImages: false, allowFileIndexing: true })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      canOptimizeImages: false,
      allowFileIndexing: true,
      createImagePreviews: false,
      effectiveOptimizeImages: false,
      optimizeImages: false,
      plan: 'free',
    })
    expect(fetch).toHaveBeenLastCalledWith(
      'https://qapi.letsoft.co/validation/project-settings',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({
          apiKey: 'qk_test',
          createImagePreviews: false,
          optimizeImages: false,
          allowFileIndexing: true,
        }),
      }),
    )
  })

  // The validation service limits this whole server by its address: what one client can make the
  // server send there is bounded.
  describe('calls to the validation service', () => {
    const key = { 'x-api-key': 'qk_test' }
    const HELD = { createImagePreviews: true, optimizeImages: true }
    const FRESH = { createImagePreviews: false, optimizeImages: true }

    type Init = { method?: string; signal?: AbortSignal }
    const isSettingsCall = (url: unknown) => String(url).includes('/validation/project-settings')
    const settingsCalls = () => vi.mocked(fetch).mock.calls.filter(([url]) => isSettingsCall(url))

    /** The key is valid and held with HELD; `settings` answers every call about the settings. */
    const central = (settings: (init: Init) => Promise<unknown>, plan?: string) =>
      vi.mocked(fetch).mockImplementation((async (url: string, init: Init = {}) =>
        isSettingsCall(url) ? settings(init) : { status: 200, json: async () => ({ valid: true, plan, settings: HELD }) }) as any)
    const answers = (body: object) => async () => ({ ok: true, status: 200, json: async () => body })
    const fails = async () => ({ ok: false, status: 500, json: async () => ({}) })
    /** Never answers; rejects, as fetch does, once its signal is aborted. */
    const hangs = (init: Init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')))
    })

    const get = () => request(app).get('/api/settings').set(key)
    const patch = (ip: string) => request(proxied).patch('/api/settings').set(key).set('X-Forwarded-For', ip)
    // Each test that counts PATCH requests does it under its own address.
    let proxied: express.Application

    beforeEach(() => {
      proxied = express()
      proxied.set('trust proxy', true)
      proxied.use(express.json())
      proxied.use('/api', settingsRouter)
    })

    afterEach(() => {
      vi.useRealTimers()
      delete process.env.RATE_LIMIT_SETTINGS
    })

    describe('GET /api/settings', () => {
      it('asks once for 20 requests within a minute', async () => {
        central(answers(FRESH))

        const first = await get()
        const rest = await Promise.all(Array.from({ length: 19 }, get))

        expect(settingsCalls()).toHaveLength(1)
        expect(first.body.createImagePreviews).toBe(false)
        for (const res of rest) {
          expect(res.status).toBe(200)
          expect(res.body).toEqual(first.body)
        }
      })

      it('asks once for 20 requests that arrive together', async () => {
        central(answers(FRESH))
        await request(app).get('/api/settings/').set(key)
        vi.mocked(fetch).mockClear()
        vi.useFakeTimers({ toFake: ['Date'] })
        vi.setSystemTime(Date.now() + 61_000)

        const results = await Promise.all(Array.from({ length: 20 }, get))

        expect(settingsCalls()).toHaveLength(1)
        for (const res of results) expect(res.status).toBe(200)
      })

      it('asks again 61 seconds later', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        central(answers(FRESH))
        await get()
        await get()
        expect(settingsCalls()).toHaveLength(1)

        vi.setSystemTime(Date.now() + 61_000)
        central(answers(HELD))
        const later = await get()

        expect(settingsCalls()).toHaveLength(2)
        expect(later.body.createImagePreviews).toBe(true)
        expect((await get()).body.createImagePreviews).toBe(true)
        expect(settingsCalls()).toHaveLength(2)
      })

      it('gives every key its own minute', async () => {
        central(answers(FRESH))
        await get()

        await request(app).get('/api/settings').set('x-api-key', 'qk_other')

        expect(settingsCalls()).toHaveLength(2)
      })

      it('answers the held settings when the call fails, and does not repeat it within the minute', async () => {
        central(fails)

        const first = await get()
        const second = await get()

        for (const res of [first, second]) {
          expect(res.status).toBe(200)
          expect(res.body.createImagePreviews).toBe(true)
        }
        expect(settingsCalls()).toHaveLength(1)
      })

      it('gives up on a call that hangs after 5 seconds and answers the held settings', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
        central(hangs)
        const pending = get()
        const answer = pending.then(res => res)
        // Aborted below if the test fails before the answer.
        answer.catch(() => {})
        try {
          while (settingsCalls().length === 0) await new Promise(resolve => setImmediate(resolve))
          const { signal } = settingsCalls()[0][1] as Init
          expect(signal?.aborted).toBe(false)

          vi.advanceTimersByTime(4999)
          expect(signal?.aborted).toBe(false)
          vi.advanceTimersByTime(1)
          expect(signal?.aborted).toBe(true)

          const res = await answer
          expect(res.status).toBe(200)
          expect(res.body.createImagePreviews).toBe(true)
        } finally {
          pending.abort()
        }
      })
    })

    // The answer about the settings carries no plan, and is asked for by one origin of the key.
    describe('what a refresh or a change keeps', () => {
      const PRO_FRESH = {
        canOptimizeImages: true,
        allowFileIndexing: false,
        createImagePreviews: false,
        effectiveOptimizeImages: true,
        optimizeImages: true,
        plan: 'pro',
      }
      const from = (origin: string) => request(app).get('/api/settings').set(key).set('Origin', origin)
      const change = (origin: string) =>
        patch('203.0.20.8').set('Origin', origin).send({ createImagePreviews: false })

      it('keeps a pro project pro after a refresh', async () => {
        central(answers(FRESH), 'pro')

        const refreshed = await get()
        const held = await get()

        expect(settingsCalls()).toHaveLength(1)
        expect(refreshed.body).toEqual(PRO_FRESH)
        expect(held.body).toEqual(PRO_FRESH)
      })

      it('keeps a pro project pro after a change', async () => {
        central(answers(HELD), 'pro')
        await get()
        central(answers(FRESH), 'pro')

        const changed = await patch('203.0.20.8').send({ createImagePreviews: false })
        const held = await get()

        expect(settingsCalls()).toHaveLength(2)
        expect(changed.body).toEqual(PRO_FRESH)
        expect(held.body).toEqual(PRO_FRESH)
      })

      it('takes the plan from the answer when it has one', async () => {
        central(answers({ ...FRESH, plan: 'free' }), 'pro')

        const refreshed = await get()

        expect(refreshed.body.plan).toBe('free')
        expect(refreshed.body.effectiveOptimizeImages).toBe(false)
        expect((await get()).body.plan).toBe('free')
      })

      it('shows a change to a second origin of the key at once', async () => {
        central(answers(HELD))
        await from('https://a.example')
        await from('https://b.example')
        central(answers(FRESH))
        expect((await change('https://a.example')).status).toBe(200)
        const calls = vi.mocked(fetch).mock.calls.length

        const other = await from('https://b.example')

        expect(other.body.createImagePreviews).toBe(false)
        expect(vi.mocked(fetch).mock.calls).toHaveLength(calls)
      })

      it('shows a refresh to a second origin of the key at once', async () => {
        vi.useFakeTimers({ toFake: ['Date'] })
        central(answers(HELD))
        await from('https://a.example')
        await from('https://b.example')
        vi.setSystemTime(Date.now() + 61_000)
        central(answers(FRESH))
        expect((await from('https://a.example')).body.createImagePreviews).toBe(false)
        const calls = vi.mocked(fetch).mock.calls.length

        const other = await from('https://b.example')

        expect(other.body.createImagePreviews).toBe(false)
        expect(vi.mocked(fetch).mock.calls).toHaveLength(calls)
      })
    })

    describe('PATCH /api/settings', () => {
      it('still asks on every request', async () => {
        central(answers(FRESH))

        await patch('203.0.20.1').send({ createImagePreviews: false })
        await patch('203.0.20.1').send({ createImagePreviews: false })

        expect(settingsCalls()).toHaveLength(2)
      })

      it('answers 429 to the 31st request of an address in a minute, without asking', async () => {
        central(answers(FRESH))
        // A real change: a body with none of the settings would not be sent on at all.
        const change = { createImagePreviews: false }
        for (let i = 0; i < 30; i++) expect((await patch('203.0.20.2').send(change)).status).toBe(200)
        expect(settingsCalls()).toHaveLength(30)

        const res = await patch('203.0.20.2').send(change)

        expect(res.status).toBe(429)
        expect(res.body).toEqual({ error: 'Too many requests', reason: 'rate_limited' })
        expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/)
        expect(settingsCalls()).toHaveLength(30)
        // Another address, and reading the settings, are not affected.
        expect((await patch('203.0.20.3').send({})).status).toBe(200)
        expect((await request(proxied).get('/api/settings').set(key).set('X-Forwarded-For', '203.0.20.2')).status).toBe(200)
      })

      it('takes the limit from RATE_LIMIT_SETTINGS', async () => {
        process.env.RATE_LIMIT_SETTINGS = '2'
        central(answers(FRESH))

        expect((await patch('203.0.20.4').send({})).status).toBe(200)
        expect((await patch('203.0.20.4').send({})).status).toBe(200)
        expect((await patch('203.0.20.4').send({})).status).toBe(429)
      })

      it('gives up on a call that hangs after 5 seconds and answers 503', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
        central(hangs)
        const pending = patch('203.0.20.5').send({ createImagePreviews: false })
        const answer = pending.then(res => res)
        // Aborted below if the test fails before the answer.
        answer.catch(() => {})
        try {
          while (settingsCalls().length === 0) await new Promise(resolve => setImmediate(resolve))
          const { signal } = settingsCalls()[0][1] as Init
          expect(signal?.aborted).toBe(false)

          vi.advanceTimersByTime(5000)
          expect(signal?.aborted).toBe(true)

          const res = await answer
          expect(res.status).toBe(503)
          expect(res.body).toEqual({ error: 'Failed to update project settings' })
          expect(res.headers['retry-after']).toBe('15')
        } finally {
          pending.abort()
        }
      })

      it('answers 503 with Retry-After when the call fails', async () => {
        central(fails)

        const res = await patch('203.0.20.7').send({ createImagePreviews: false })

        expect(res.status).toBe(503)
        expect(res.body).toEqual({ error: 'Failed to update project settings' })
        expect(res.headers['retry-after']).toBe('15')
      })

      it('makes no call for a body with none of the settings, and answers the held ones', async () => {
        central(answers(FRESH))

        const res = await patch('203.0.20.6').send({ createImagePreviews: 'no', unknown: true })

        expect(res.status).toBe(200)
        expect(res.body).toEqual({
          canOptimizeImages: false,
          allowFileIndexing: false,
          createImagePreviews: true,
          effectiveOptimizeImages: false,
          optimizeImages: true,
          plan: 'free',
        })
        expect(settingsCalls()).toHaveLength(0)
      })

      // The limit per address multiplies by the number of addresses; this one does not.
      describe('from all addresses together', () => {
        const change = (i: number) => patch(`198.51.100.${i}`).send({ createImagePreviews: false })
        const expectHeldBack = (res: request.Response) => {
          expect(res.status).toBe(503)
          expect(res.body).toEqual({ error: 'Failed to update project settings' })
          expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/)
        }

        afterEach(() => {
          delete process.env.SETTINGS_UPDATE_GLOBAL_LIMIT
        })

        it('sends 60 changes a minute and answers 503 with Retry-After to the 61st, without asking', async () => {
          central(answers(FRESH))
          for (let i = 0; i < 60; i++) expect((await change(i)).status).toBe(200)
          expect(settingsCalls()).toHaveLength(60)

          expectHeldBack(await change(60))

          expect(settingsCalls()).toHaveLength(60)
        })

        it('does not let requests that arrive together go over the limit', async () => {
          process.env.SETTINGS_UPDATE_GLOBAL_LIMIT = '3'
          central(answers(FRESH))
          // Validated first: the requests below then reach the route in one turn.
          await get()
          vi.mocked(fetch).mockClear()

          const results = await Promise.all(Array.from({ length: 10 }, (_, i) => change(i)))

          expect(settingsCalls()).toHaveLength(3)
          const heldBack = results.filter(res => res.status !== 200)
          expect(heldBack).toHaveLength(7)
          heldBack.forEach(expectHeldBack)
        })

        it('takes the limit from SETTINGS_UPDATE_GLOBAL_LIMIT and says when the window ends', async () => {
          vi.useFakeTimers({ toFake: ['Date'] })
          process.env.SETTINGS_UPDATE_GLOBAL_LIMIT = '2'
          central(answers(FRESH))
          expect((await change(0)).status).toBe(200)
          vi.setSystemTime(Date.now() + 20_000)
          expect((await change(1)).status).toBe(200)

          const third = await change(2)

          expectHeldBack(third)
          expect(third.headers['retry-after']).toBe('40')
          expect(settingsCalls()).toHaveLength(2)
        })

        it('starts a new window a minute later', async () => {
          vi.useFakeTimers({ toFake: ['Date'] })
          process.env.SETTINGS_UPDATE_GLOBAL_LIMIT = '1'
          central(answers(FRESH))
          await change(0)
          expectHeldBack(await change(1))
          vi.setSystemTime(Date.now() + 60_000)

          expect((await change(1)).status).toBe(200)
        })

        it('does not count a body with none of the settings', async () => {
          process.env.SETTINGS_UPDATE_GLOBAL_LIMIT = '1'
          central(answers(FRESH))
          for (let i = 0; i < 3; i++) await patch(`198.51.100.${i}`).send({})

          expect((await change(3)).status).toBe(200)
        })
      })
    })
  })
})
