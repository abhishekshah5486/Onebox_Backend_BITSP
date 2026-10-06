import { describe, expect, it } from 'vitest';
import {
  AppError,
  ConflictError,
  ExternalServiceError,
  NotFoundError,
  ServiceUnavailableError,
  ValidationError,
  isAppError,
} from './app-error';

describe('AppError subclasses', () => {
  it.each([
    [new ValidationError('bad'), 'VALIDATION_FAILED', 400, false],
    [new NotFoundError('missing'), 'NOT_FOUND', 404, false],
    [new ConflictError('dup'), 'CONFLICT', 409, false],
    [new ExternalServiceError('llm down'), 'EXTERNAL_SERVICE_ERROR', 502, true],
    [new ServiceUnavailableError('busy'), 'SERVICE_UNAVAILABLE', 503, true],
  ])('%s has code %s, status %i, retryable %s', (error, code, statusCode, retryable) => {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code, statusCode, retryable });
  });

  it('allows a specific code, details and cause', () => {
    const cause = new Error('dup key');
    const error = new ConflictError('Email taken', {
      code: 'EMAIL_TAKEN',
      details: { field: 'email' },
      cause,
    });

    expect(error).toMatchObject({
      code: 'EMAIL_TAKEN',
      statusCode: 409,
      details: { field: 'email' },
    });
    expect(error.cause).toBe(cause);
  });

  it('allows overriding retryable', () => {
    expect(new ExternalServiceError('401 from provider', { retryable: false }).retryable).toBe(
      false,
    );
  });

  it('isAppError distinguishes plain errors', () => {
    expect(isAppError(new NotFoundError('x'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError('x')).toBe(false);
  });
});
