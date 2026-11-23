export interface AppErrorOptions {
  code: string;
  statusCode: number;
  details?: unknown;
  retryable?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: unknown;
  readonly retryable: boolean;

  constructor(message: string, options: AppErrorOptions) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.details = options.details;
    this.retryable = options.retryable ?? false;
  }
}

type SubclassOptions = Omit<AppErrorOptions, 'code' | 'statusCode'> & { code?: string };

function defineError(defaultCode: string, statusCode: number, retryable = false) {
  return class extends AppError {
    constructor(message: string, options: SubclassOptions = {}) {
      super(message, { retryable, ...options, code: options.code ?? defaultCode, statusCode });
    }
  };
}

export class ValidationError extends defineError('VALIDATION_FAILED', 400) {}
export class UnauthorizedError extends defineError('UNAUTHORIZED', 401) {}
// The user has to pay (e.g. top up credits) before this can go ahead.
export class PaymentRequiredError extends defineError('PAYMENT_REQUIRED', 402) {}
export class ForbiddenError extends defineError('FORBIDDEN', 403) {}
export class NotFoundError extends defineError('NOT_FOUND', 404) {}
export class ConflictError extends defineError('CONFLICT', 409) {}
export class UnprocessableError extends defineError('UNPROCESSABLE', 422) {}
export class RateLimitedError extends defineError('RATE_LIMITED', 429) {}
export class ExternalServiceError extends defineError('EXTERNAL_SERVICE_ERROR', 502, true) {}
export class ServiceUnavailableError extends defineError('SERVICE_UNAVAILABLE', 503, true) {}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
