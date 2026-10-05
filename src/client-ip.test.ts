import { describe, it, expect } from 'vitest'
import { clientIp } from './client-ip'

const req = (ip?: string, remoteAddress?: string) => ({ ip, socket: { remoteAddress } }) as any

describe('clientIp', () => {
  it('uses the address Express resolved', () => {
    expect(clientIp(req('203.0.113.7'))).toBe('203.0.113.7')
  })

  it('falls back to the socket, then to a constant', () => {
    expect(clientIp(req(undefined, '198.51.100.2'))).toBe('198.51.100.2')
    expect(clientIp({} as any)).toBe('unknown')
  })

  it('unwraps an IPv4 address mapped into IPv6', () => {
    expect(clientIp(req('::ffff:203.0.113.7'))).toBe('203.0.113.7')
  })

  it('counts a whole IPv6 /64 as one client', () => {
    expect(clientIp(req('2001:db8:1:2:aaaa:bbbb:cccc:dddd'))).toBe('2001:db8:1:2::/64')
    expect(clientIp(req('2001:db8:1:2::1'))).toBe('2001:db8:1:2::/64')
    expect(clientIp(req('2001:db8::1'))).toBe('2001:db8:0:0::/64')
    expect(clientIp(req('::1'))).toBe('0:0:0:0::/64')
  })

  // With a trusted proxy `req.ip` is whatever X-Forwarded-For said: garbage must not become a Map key.
  it('ignores a value that is not an IP address and uses the socket instead', () => {
    expect(clientIp(req('not-an-ip', '198.51.100.2'))).toBe('198.51.100.2')
    expect(clientIp(req('1.2.3.4, evil', '::ffff:198.51.100.3'))).toBe('198.51.100.3')
    expect(clientIp(req('::ffff:evil.host', '2001:db8:1:2::9'))).toBe('2001:db8:1:2::/64')
  })

  it('answers a constant when the socket address is not an IP address either', () => {
    expect(clientIp(req('not-an-ip', 'also garbage'))).toBe('unknown')
    expect(clientIp(req('x'.repeat(5000)))).toBe('unknown')
  })
})
