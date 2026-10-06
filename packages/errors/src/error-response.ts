import { isAppError } from './app-error';

export interface ErrorResponse {
  statusCode: number;
  body: { error: { code: string; message: string; details?: unknown } };
}

// Unknown errors are masked so internals never reach API clients.
export function toErrorResponse(error: unknown): ErrorResponse {
  if (!isAppError(error)) {
    return {
      statusCode: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    };
  }
  return {
    statusCode: error.statusCode,
    body: {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined && { details: error.details }),
      },
    },
  };
}
