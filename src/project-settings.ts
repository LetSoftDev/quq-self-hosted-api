import type { Request } from 'express'

export interface ProjectImageSettings {
  createImagePreviews: boolean
  optimizeImages: boolean
  allowFileIndexing: boolean
  plan?: 'free' | 'pro' | 'custom' | string
  canOptimizeImages: boolean
  effectiveOptimizeImages: boolean
}

export interface ProjectAuthContext {
  apiKey: string
  origin: string
  settings: ProjectImageSettings
}

export const DEFAULT_PROJECT_IMAGE_SETTINGS: ProjectImageSettings = {
  createImagePreviews: true,
  optimizeImages: true,
  allowFileIndexing: false,
  plan: 'free',
  canOptimizeImages: false,
  effectiveOptimizeImages: false,
}

let staticFileIndexingAllowed = DEFAULT_PROJECT_IMAGE_SETTINGS.allowFileIndexing

export const ROBOTS_NO_INDEX_HEADER = 'noindex, nofollow, noarchive'

export function normalizeProjectImageSettings(value: Partial<ProjectImageSettings> | undefined): ProjectImageSettings {
  const plan = value?.plan ?? DEFAULT_PROJECT_IMAGE_SETTINGS.plan
  const canOptimizeImages = value?.canOptimizeImages ?? (plan === 'pro' || plan === 'custom')
  const optimizeImages = value?.optimizeImages ?? DEFAULT_PROJECT_IMAGE_SETTINGS.optimizeImages
  return {
    createImagePreviews: value?.createImagePreviews ?? DEFAULT_PROJECT_IMAGE_SETTINGS.createImagePreviews,
    optimizeImages,
    allowFileIndexing: value?.allowFileIndexing ?? DEFAULT_PROJECT_IMAGE_SETTINGS.allowFileIndexing,
    plan,
    canOptimizeImages,
    effectiveOptimizeImages: value?.effectiveOptimizeImages ?? (optimizeImages && canOptimizeImages),
  }
}

export function getProjectAuthContext(req: Request): ProjectAuthContext | undefined {
  return (req as Request & { quqProject?: ProjectAuthContext }).quqProject
}

export function setProjectAuthContext(req: Request, context: ProjectAuthContext): void {
  ;(req as Request & { quqProject?: ProjectAuthContext }).quqProject = context
  staticFileIndexingAllowed = context.settings.allowFileIndexing
}

export function getProjectImageSettings(req: Request): ProjectImageSettings {
  return getProjectAuthContext(req)?.settings ?? DEFAULT_PROJECT_IMAGE_SETTINGS
}

export function setStaticFileIndexingAllowed(value: boolean): void {
  staticFileIndexingAllowed = value
}

export function getStaticFileIndexingAllowed(): boolean {
  return staticFileIndexingAllowed
}
