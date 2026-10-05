import express, { type RequestHandler } from 'express'
import path from 'path'
import { attachmentDisposition, isActiveContent } from './active-content'

/**
 * Public serving of uploaded files, for /files and the legacy /uploads alias.
 *
 * Anyone who holds the project's API key can upload, so a file is never trusted to be what its
 * name says. A file the browser would render as a document and run script in (HTML, SVG, XML, JS)
 * is sent as a download; `<img>` and `<script>` do not look at Content-Disposition and keep working.
 */
export function publicFiles(uploadsDir: string): RequestHandler {
  return express.static(uploadsDir, {
    // Set explicitly, so every path segment is checked: without it only a dot *file* is refused,
    // and .trash/<id>/<name> and .previews/... are served to anyone.
    dotfiles: 'ignore',
    // No index.html behind a folder URL, and no redirect that tells a folder exists.
    index: false,
    redirect: false,
    setHeaders(res, filePath) {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const name = path.basename(filePath)
      if (isActiveContent(express.static.mime.lookup(filePath), name)) {
        res.setHeader('Content-Disposition', attachmentDisposition(name))
        // Not on every file: `sandbox` stops the browser's PDF viewer.
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
      }
    },
  })
}
