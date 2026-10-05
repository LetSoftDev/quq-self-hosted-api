import { describe, it, expect } from 'vitest'
import http from 'http'
import type { AddressInfo } from 'net'
import express from 'express'
import request from 'supertest'

const listening = (server: http.Server): Promise<AddressInfo> =>
  new Promise(resolve => server.once('listening', () => resolve(server.address() as AddressInfo)))

const close = (server: http.Server): Promise<void> => new Promise(resolve => server.close(() => resolve()))

describe('test servers', () => {
  it('bind to 127.0.0.1 when a test asks for any free port', async () => {
    const server = http.createServer().listen(0)

    expect((await listening(server)).address).toBe('127.0.0.1')
    await close(server)
  })

  it('bind to 127.0.0.1 when the port comes with a callback', async () => {
    const server = http.createServer()
    await new Promise<void>(resolve => server.listen(0, resolve))

    expect((server.address() as AddressInfo).address).toBe('127.0.0.1')
    await close(server)
  })

  it('keep a host that the test names itself', async () => {
    const server = http.createServer().listen(0, 'localhost')

    expect(['127.0.0.1', '::1']).toContain((await listening(server)).address)
    await close(server)
  })

  it('are the ones supertest starts', async () => {
    const app = express()
    app.get('/where', (req, res) => res.json({ address: req.socket.localAddress }))

    const res = await request(app).get('/where')

    expect(res.body).toEqual({ address: '127.0.0.1' })
  })
})
