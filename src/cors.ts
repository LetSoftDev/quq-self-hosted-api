import type { Request, Response, NextFunction } from 'express'
import type { CorsOptions } from 'cors'

export const corsOptions: CorsOptions = {
  origin: true,
  credentials: true,
  allowedHeaders: ['Content-Type', 'x-api-key'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
}

export function staticCorsHeaders(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin

  res.header('Access-Control-Allow-Origin', typeof origin === 'string' ? origin : '*')
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-api-key')
  res.header('Vary', 'Origin')
  next()
}
