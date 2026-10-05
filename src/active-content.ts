import path from 'path'

/** Types a browser renders as a document and may run script in. Opened by link they must download. */
const ACTIVE_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'image/svg+xml',
  'text/xml', 'application/xml', 'text/xsl', 'application/xslt+xml',
  'text/javascript', 'application/javascript', 'application/x-javascript', 'text/ecmascript', 'application/ecmascript',
])
const ACTIVE_EXTENSIONS = new Set(['.html', '.htm', '.shtml', '.xhtml', '.xht', '.svg', '.svgz', '.xml', '.xsl', '.xslt', '.js', '.mjs', '.cjs'])

/** `mime` is the type the file will be served with. Either the type or the name is enough. */
export function isActiveContent(mime: string | null | undefined, fileName: string): boolean {
  const type = (mime ?? '').split(';')[0].trim().toLowerCase()
  return ACTIVE_TYPES.has(type) || type.endsWith('+xml') || ACTIVE_EXTENSIONS.has(path.extname(fileName).toLowerCase())
}

/** RFC 6266 attachment with an ASCII fallback and the exact UTF-8 name. */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}
