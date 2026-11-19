export class HttpStatusError extends Error {
  readonly status: number
  readonly provider: string

  constructor(message: string, status: number, provider: string) {
    super(message)
    this.name = 'HttpStatusError'
    this.status = status
    this.provider = provider
  }
}
