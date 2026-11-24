import type { ContentfulStatusCode } from 'hono/utils/http-status'

export class AppError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const notFound = (what: string) => new AppError(404, 'NotFound', `${what} not found`)
export const badRequest = (message: string) => new AppError(400, 'BadRequest', message)
export const conflict = (message: string) => new AppError(409, 'Conflict', message)
export const unauthorized = (message = 'Not signed in') => new AppError(401, 'Unauthorized', message)
export const forbidden = (message = 'Not allowed') => new AppError(403, 'Forbidden', message)
export const tooManyRequests = () =>
  new AppError(429, 'TooManyRequests', 'Too many requests. Wait a few minutes and try again.')
