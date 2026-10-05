import type { Request } from 'express'
import { isIP } from 'net'

const unwrapMapped = (raw: string): string =>
  raw.startsWith('::ffff:') && raw.includes('.') ? raw.slice(7) : raw

/**
 * The address to count a client by. `req.ip` honours the app's `trust proxy` setting. An IPv6
 * client usually holds a whole /64, so it is counted as one.
 *
 * With a trusted proxy `req.ip` is whatever X-Forwarded-For said, so a value that is not an IP
 * address is ignored: otherwise a client could mint a new "address" (of any length) per request.
 */
export function clientIp(req: Request): string {
  const ip = [req.ip, req.socket?.remoteAddress]
    .map((raw) => unwrapMapped(raw ?? ''))
    .find((candidate) => isIP(candidate) !== 0)
  if (!ip) return 'unknown'
  if (!ip.includes(':')) return ip

  const [head, tail] = ip.split('::')
  const headParts = head ? head.split(':') : []
  const tailParts = tail ? tail.split(':') : []
  const groups = ip.includes('::')
    ? [...headParts, ...new Array(Math.max(8 - headParts.length - tailParts.length, 0)).fill('0'), ...tailParts]
    : headParts
  return `${groups.slice(0, 4).join(':')}::/64`
}
