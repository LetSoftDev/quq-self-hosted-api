export const VALIDATION_API_URL = 'https://qapi.letsoft.co'
const VALIDATION_TIMEOUT_MS = 5000

/**
 * One call to the validation service: `call` gets a signal that is aborted after 5 seconds, the
 * reading of the body included. A service that accepts the connection and never answers must not
 * hold a request, and whatever waits for it, for as long as it likes.
 */
export async function withValidationTimeout<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS)
  try {
    return await call(controller.signal)
  } finally {
    clearTimeout(timeoutId)
  }
}
