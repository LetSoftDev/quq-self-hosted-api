// First, before any module reads process.env: routes/files.ts reads MAX_FILE_SIZE when it is loaded.
import 'dotenv/config'
import { createApp } from './app'
import { tidyPreviews } from './startup'

const PORT = process.env.PORT || 3000
const UPLOADS_DIR = process.env.UPLOADS_DIR || './uploads'
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || '1800000')

// Older versions left thumbnails in the public .previews folder: of trashed items, and of deleted
// ones. Before listening, so the clean-up cannot race a request that moves a file and its thumbnail.
// It never rejects, so it cannot stop the server from starting.
void tidyPreviews().then(() => {
  const server = createApp().listen(PORT, () => {
    console.log(`Backend running on http://localhost:${PORT}`)
    console.log(`Storage directory: ${UPLOADS_DIR}`)
  })

  server.requestTimeout = REQUEST_TIMEOUT_MS
  server.timeout = REQUEST_TIMEOUT_MS
  server.headersTimeout = Math.min(60000, REQUEST_TIMEOUT_MS)
})
