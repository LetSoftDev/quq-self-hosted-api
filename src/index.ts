import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { filesRouter } from './routes/files'
import { activityRouter } from './routes/activity'
import { starsRouter } from './routes/stars'
import { trashRouter } from './routes/trash'
import { storageRouter } from './routes/storage'
import { corsOptions, staticCorsHeaders } from './cors'

dotenv.config()

const app = express()
const PORT = process.env.PORT || 3000
const UPLOADS_DIR = process.env.UPLOADS_DIR || './uploads'

// Middleware
app.use(cors(corsOptions))
app.use(express.json())

// Routes
app.use('/api', filesRouter)
app.use('/api', activityRouter)
app.use('/api', starsRouter)
app.use('/api', trashRouter)
app.use('/api', storageRouter)

// Static file serving with CORS
app.use('/files', staticCorsHeaders, express.static(UPLOADS_DIR))

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' })
})

// Start server
app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`)
  console.log(`Storage directory: ${UPLOADS_DIR}`)
})
