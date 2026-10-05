import type { ErrorRequestHandler, Response } from 'express'
import multer from 'multer'

/** An error whose message is meant for the client: bad input, not a fault of the server. */
export class RequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message)
  }
}

/**
 * File-system codes that say the request cannot be done on this tree: a name too long for the
 * disk, a folder where a file is expected, a folder moved or copied into itself.
 */
const INVALID_REQUEST_CODES = new Set(['ENAMETOOLONG', 'EISDIR', 'ENOTEMPTY', 'EEXIST', 'EINVAL', 'ERR_FS_CP_EINVAL'])

/** The answer to an error that is the client's, or undefined for one that is ours. */
function clientAnswer(error: unknown): { status: number; error: string } | undefined {
  if (error instanceof RequestError) return { status: error.status, error: error.message }
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return { status: 404, error: 'Not found' }
  if (code && INVALID_REQUEST_CODES.has(code)) return { status: 400, error: 'Invalid request' }
  return undefined
}

/**
 * The one place a failure becomes a response. A file-system message carries the server's absolute
 * path, so only our own messages are sent; the rest goes to the log.
 */
export function sendError(res: Response, error: unknown): void {
  const answer = clientAnswer(error)
  if (answer) {
    res.status(answer.status).json({ error: answer.error })
    return
  }
  console.error('[api]', error)
  res.status(500).json({ error: 'Internal server error' })
}

// busboy and multer report a malformed or abandoned multipart body as a plain Error. These are
// all of their messages (busboy 1.6, multer 2.4).
const BROKEN_MULTIPART = /^(Multipart: |Malformed part header|Malformed content type|Unsupported content type|Unexpected end of (form|file)|Request (aborted|closed))/

function isInvalidUpload(error: unknown): boolean {
  if (error instanceof multer.MulterError) return true
  // A code means the file system failed while the upload was stored, and that is ours.
  return error instanceof Error && (error as NodeJS.ErrnoException).code === undefined && BROKEN_MULTIPART.test(error.message)
}

/**
 * Express's last resort, for errors raised outside a route's own try/catch: a malformed JSON body,
 * a refused upload, a file or thumbnail that could not be sent. Without it Express answers with an
 * HTML page, and outside production that page carries a stack trace.
 */
export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  // Nothing can be answered in the middle of a response: Express closes the connection.
  if (res.headersSent) {
    next(error)
    return
  }
  // A file handler has already described the file it then did not send, and res.json keeps a
  // Content-Type that is set.
  res.removeHeader('Content-Disposition')
  res.removeHeader('Content-Security-Policy')
  res.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (error?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'File too large' })
    return
  }
  if (isInvalidUpload(error)) {
    res.status(400).json({ error: 'Invalid upload' })
    return
  }
  // Before the status: a missing file comes from `send` as ENOENT with status 404.
  if (!clientAnswer(error) && typeof error?.status === 'number' && error.status >= 400 && error.status < 500) {
    res.status(error.status).json({ error: 'Invalid request' })
    return
  }
  sendError(res, error)
}
