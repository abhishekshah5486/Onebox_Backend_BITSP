import { describe, expect, it } from 'vitest';
import { NotFoundError, ValidationError } from './app-error';
import { toErrorResponse } from './error-response';

describe('toErrorResponse', () => {
  it('maps an AppError to its status and code', () => {
    expect(toErrorResponse(new NotFoundError('Thread not found'))).toEqual({
      statusCode: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Thread not found' } },
    });
  });

  it('includes details when present', () => {
    const response = toErrorResponse(
      new ValidationError('Invalid', { details: [{ path: 'email' }] }),
    );
    expect(response.body.error.details).toEqual([{ path: 'email' }]);
  });

  it('masks unknown errors as 500', () => {
    expect(toErrorResponse(new Error('connection string leaked'))).toEqual({
      statusCode: 500,
      body: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
    });
  });
});
