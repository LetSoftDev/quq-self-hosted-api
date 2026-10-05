import { LocalStorage } from './local'

let storage: LocalStorage | null = null

export const getStorage = (): LocalStorage => {
  if (!storage) {
    storage = new LocalStorage(process.env.UPLOADS_DIR || './uploads')
  }
  return storage
}

/** For tests: forget the instance so the next call picks up UPLOADS_DIR again. */
export const resetStorage = (): void => {
  storage = null
}
