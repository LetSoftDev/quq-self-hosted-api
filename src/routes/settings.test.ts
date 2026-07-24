import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
        }),
      })

    const res = await request(app)
      .patch('/api/settings')
      .set('x-api-key', 'qk_test')
      .send({ createImagePreviews: false, optimizeImages: false })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      canOptimizeImages: false,
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
        }),
      }),
    )
  })
})
