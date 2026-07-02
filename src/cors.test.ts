import { describe, expect, it, vi } from 'vitest'
import { corsOptions, staticCorsHeaders } from './cors'

describe('backend-simple CORS', () => {
  it('uses dynamic origin so backend-pro validation remains the source of truth', () => {
    expect(corsOptions.origin).toBe(true)
    expect(corsOptions.credentials).toBe(true)
    expect(corsOptions.allowedHeaders).toEqual(['Content-Type', 'x-api-key'])
  })

  it('reflects the request origin for public file responses', () => {
    const req = { headers: { origin: 'http://localhost:5190' } } as any
    const res = { header: vi.fn() } as any
    const next = vi.fn()

    staticCorsHeaders(req, res, next)

    expect(res.header).toHaveBeenCalledWith('Access-Control-Allow-Origin', 'http://localhost:5190')
    expect(res.header).toHaveBeenCalledWith('Access-Control-Allow-Methods', 'GET, OPTIONS')
    expect(res.header).toHaveBeenCalledWith('Access-Control-Allow-Headers', 'Content-Type, x-api-key')
    expect(res.header).toHaveBeenCalledWith('Vary', 'Origin')
    expect(next).toHaveBeenCalled()
  })

  it('allows static file access without an Origin header', () => {
    const req = { headers: {} } as any
    const res = { header: vi.fn() } as any
    const next = vi.fn()

    staticCorsHeaders(req, res, next)

    expect(res.header).toHaveBeenCalledWith('Access-Control-Allow-Origin', '*')
    expect(next).toHaveBeenCalled()
  })
})
