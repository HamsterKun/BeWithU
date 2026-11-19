import { HttpStatusError } from './http-error'

export function shouldRetryWithoutImage(error: unknown): boolean {
  if (error instanceof HttpStatusError) return error.provider === 'llm' && error.status === 400
  const message = error instanceof Error ? error.message : String(error)
  return /image|vision|multi-?modal|content[ _-]?type|unsupported/i.test(message)
}

export function shouldRetryBreeze429(error: unknown): boolean {
  return error instanceof HttpStatusError && error.provider === 'breeze' && error.status === 429
}
