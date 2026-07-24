import type { Request } from 'express'

export interface ProjectImageSettings {
  createImagePreviews: boolean
  optimizeImages: boolean
}

export interface ProjectAuthContext {
  apiKey: string
  origin: string
  settings: ProjectImageSettings
}

export const DEFAULT_PROJECT_IMAGE_SETTINGS: ProjectImageSettings = {
  createImagePreviews: true,
  optimizeImages: true,
}

export function normalizeProjectImageSettings(value: Partial<ProjectImageSettings> | undefined): ProjectImageSettings {
  return {
    createImagePreviews: value?.createImagePreviews ?? DEFAULT_PROJECT_IMAGE_SETTINGS.createImagePreviews,
    optimizeImages: value?.optimizeImages ?? DEFAULT_PROJECT_IMAGE_SETTINGS.optimizeImages,
  }
}

export function getProjectAuthContext(req: Request): ProjectAuthContext | undefined {
  return (req as Request & { quqProject?: ProjectAuthContext }).quqProject
}

export function setProjectAuthContext(req: Request, context: ProjectAuthContext): void {
  ;(req as Request & { quqProject?: ProjectAuthContext }).quqProject = context
}

export function getProjectImageSettings(req: Request): ProjectImageSettings {
  return getProjectAuthContext(req)?.settings ?? DEFAULT_PROJECT_IMAGE_SETTINGS
}
