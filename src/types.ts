export interface QuqFile {
  name: string
  path: string
  type: 'file' | 'dir'
  url: string
  mime?: string
  size?: number
  modified?: number
  preview?: string
  starred?: boolean
}

export interface ListResponse {
  files: QuqFile[]
  total: number
  hasMore: boolean
}

export interface ActivitySummary {
  quickAccess: QuqFile[]
  recentFiles: QuqFile[]
}
