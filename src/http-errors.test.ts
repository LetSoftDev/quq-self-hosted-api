import { describe, it, expect, vi, afterEach } from 'vitest'
import multer from 'multer'
import { RequestError, errorHandler, sendError } from './http-errors'

const makeRes = () => {
  const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn(), removeHeader: vi.fn(), headersSent: false } as any
  res.status.mockReturnValue(res)
  return res
}

describe('sendError', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sends a RequestError as it is', () => {
    const res = makeRes()

    sendError(res, new RequestError('path traversal detected'))

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'path traversal detected' })
  })

  it.each(['ENOENT', 'ENOTDIR'])('turns %s into 404 without the path', code => {
    const res = makeRes()

    sendError(res, Object.assign(new Error(`${code}: no such file, open '/srv/app/uploads/x'`), { code }))

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'Not found' })
  })

  it.each(['ENAMETOOLONG', 'EISDIR', 'ENOTEMPTY', 'EEXIST', 'EINVAL', 'ERR_FS_CP_EINVAL'])(
    'turns %s into 400 without the path, and does not log it',
    code => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const res = makeRes()

      sendError(res, Object.assign(new Error(`${code}: mkdir '/srv/app/uploads/x'`), { code }))

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid request' })
      expect(log).not.toHaveBeenCalled()
    },
  )

  it('hides anything else and logs it', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = makeRes()
    const error = Object.assign(new Error("EACCES: permission denied, open '/srv/app/uploads/x'"), { code: 'EACCES' })

    sendError(res, error)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' })
    expect(log).toHaveBeenCalledWith('[api]', error)
  })
})

describe('errorHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const handle = (error: unknown) => {
    const res = makeRes()
    errorHandler(error, {} as any, res, vi.fn())
    return res
  }

  it.each(['LIMIT_UNEXPECTED_FILE', 'LIMIT_PART_COUNT', 'LIMIT_FIELD_KEY', 'MISSING_FIELD_NAME'])(
    'answers 400 for the upload error %s, and does not log it',
    code => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})

      const res = handle(new multer.MulterError(code as multer.ErrorCode, 'file'))

      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith({ error: 'Invalid upload' })
      expect(log).not.toHaveBeenCalled()
    },
  )

  it('still answers 413 when the size limit arrives as a MulterError', () => {
    const res = handle(new multer.MulterError('LIMIT_FILE_SIZE', 'file'))

    expect(res.status).toHaveBeenCalledWith(413)
    expect(res.json).toHaveBeenCalledWith({ error: 'File too large' })
  })

  it.each([
    'Multipart: Boundary not found',
    'Unexpected end of form',
    'Unexpected end of file',
    'Malformed part header',
    'Unsupported content type: multipart/mixed',
    'Request aborted',
    'Request closed',
  ])('answers 400 for the broken multipart body reported as "%s"', message => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = handle(new Error(message))

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid upload' })
    expect(log).not.toHaveBeenCalled()
  })

  it('does not take a file-system failure during an upload for a broken body', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = handle(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: 'ENOSPC' }))

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' })
  })

  it('answers a RequestError and a known file-system code as sendError does, whatever status they carry', () => {
    expect(handle(new RequestError('Invalid path')).json).toHaveBeenCalledWith({ error: 'Invalid path' })

    const missing = handle(Object.assign(new Error("ENOENT: stat '/srv/app/uploads/.previews/x'"), { code: 'ENOENT', status: 404 }))
    expect(missing.status).toHaveBeenCalledWith(404)
    expect(missing.json).toHaveBeenCalledWith({ error: 'Not found' })
  })

  it('always labels its answer as JSON and drops the headers of a file that was not sent', () => {
    const res = handle(Object.assign(new Error('Range Not Satisfiable'), { status: 416 }))

    expect(res.status).toHaveBeenCalledWith(416)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid request' })
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8')
    expect(res.removeHeader).toHaveBeenCalledWith('Content-Disposition')
    expect(res.removeHeader).toHaveBeenCalledWith('Content-Security-Policy')
  })

  it('leaves a response that has already started to Express', () => {
    const res = { ...makeRes(), headersSent: true }
    const next = vi.fn()
    const error = new Error('read failed')

    errorHandler(error, {} as any, res, next)

    expect(next).toHaveBeenCalledWith(error)
    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })

  it('answers 413 when an upload is over the size limit', () => {
    const res = handle(Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' }))

    expect(res.status).toHaveBeenCalledWith(413)
    expect(res.json).toHaveBeenCalledWith({ error: 'File too large' })
  })

  it('answers a client error from a parser with its status and a fixed message', () => {
    const res = handle(Object.assign(new SyntaxError("Unexpected token b in JSON at position 1"), { status: 400 }))

    expect(res.status).toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid request' })
  })

  it('hides everything else', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = handle(new Error("EACCES: permission denied, open '/srv/app/uploads/x'"))

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Internal server error' })
  })
})
