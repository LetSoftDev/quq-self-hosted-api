import { describe, it, expect, afterEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { rateLimit, trustProxyFromEnv } from './rate-limit'

const appWith = (now: () => number) => {
  const app = express()
  app.set('trust proxy', true)
  app.use(rateLimit('RATE_LIMIT_TEST', 3, now))
  app.get('/', (_req, res) => res.json({ ok: true }))
  return app
}

describe('rateLimit', () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_TEST
    delete process.env.TRUST_PROXY
  })

  it('allows the limit, then answers 429 with Retry-After until the window ends', async () => {
    let now = 0
    const app = appWith(() => now)
    for (let i = 0; i < 3; i++) await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(200)

    now = 20_000
    const blocked = await request(app).get('/').set('X-Forwarded-For', '203.0.113.1')

    expect(blocked.status).toBe(429)
    expect(blocked.body).toEqual({ error: 'Too many requests', reason: 'rate_limited' })
    expect(blocked.headers['retry-after']).toBe('40')

    now = 60_001
    await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(200)
  })

  it('counts each address on its own', async () => {
    const app = appWith(() => 0)
    for (let i = 0; i < 3; i++) await request(app).get('/').set('X-Forwarded-For', '203.0.113.1').expect(200)

    await request(app).get('/').set('X-Forwarded-For', '203.0.113.2').expect(200)
  })

  it('reads the limit from the environment on every request', async () => {
    process.env.RATE_LIMIT_TEST = '1'
    const app = appWith(() => 0)

    await request(app).get('/').expect(200)
    await request(app).get('/').expect(429)
  })
})

describe('trustProxyFromEnv', () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY
  })

  it('trusts private-network proxies by default: nginx on the host and Docker\'s bridge', () => {
    expect(trustProxyFromEnv()).toBe('loopback, linklocal, uniquelocal')
  })

  it.each([['false', false], ['0', false], ['2', 2], ['loopback', 'loopback'], ['10.0.0.0/8', '10.0.0.0/8']])(
    'reads TRUST_PROXY=%s',
    (value, expected) => {
      process.env.TRUST_PROXY = value as string
      expect(trustProxyFromEnv()).toBe(expected)
    },
  )
})
