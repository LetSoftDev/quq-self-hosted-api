import express, { type Application, type Request } from 'express'
import cors from 'cors'
import { filesRouter } from './routes/files'
import { activityRouter } from './routes/activity'
import { starsRouter } from './routes/stars'
import { trashRouter } from './routes/trash'
import { storageRouter } from './routes/storage'
import { settingsRouter } from './routes/settings'
import { corsOptions, staticCorsHeaders } from './cors'
import { publicFiles } from './static-files'
import { rateLimit, trustProxyFromEnv } from './rate-limit'
import { errorHandler } from './http-errors'

export function createApp(): Application {
  const app = express()
  const uploadsDir = process.env.UPLOADS_DIR || './uploads'

  app.disable('x-powered-by')
  app.set('trust proxy', trustProxyFromEnv())

  app.use(cors(corsOptions))

  // Per address, per minute, and before a body is parsed: a throttled address costs its 429 only.
  // Previews are <img> requests from customers' pages, so they do not eat this limit. Their own,
  // like those of upload, search and storage, is set on the route: a prefix here would be skipped
  // by `/api//upload`, which still reaches the route. /files and /uploads are not limited.
  const apiLimit = rateLimit('RATE_LIMIT_API', 600)
  // GET and HEAD only: that is what the preview route answers. Anything else sent to that path
  // goes on to the API-key check, and is counted like every other API call.
  const isPreviewRequest = (req: Request): boolean =>
    (req.method === 'GET' || req.method === 'HEAD') && /^\/preview\/?$/i.test(req.path)
  app.use('/api', (req, res, next) => (isPreviewRequest(req) ? next() : apiLimit(req, res, next)))

  app.use(express.json())

  app.use('/api', filesRouter)
  app.use('/api', activityRouter)
  app.use('/api', starsRouter)
  app.use('/api', trashRouter)
  app.use('/api', storageRouter)
  app.use('/api', settingsRouter)

  // Whatever no router answered. After them, so it stands in front of no route, and after their
  // API-key check: without a key the answer is still 401. Express's own 404 is an HTML page.
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found' })
  })

  // /files is the current QuqManager public file URL prefix.
  // /uploads is kept as a legacy alias for projects migrated from the old file manager.
  app.use('/files', staticCorsHeaders, publicFiles(uploadsDir))
  app.use('/uploads', staticCorsHeaders, publicFiles(uploadsDir))

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' })
  })

  app.use(errorHandler)

  return app
}
