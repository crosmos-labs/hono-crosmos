import { describe, expect, test } from 'bun:test';
import { AppError, errorEnvelope, errorResponse } from '../src/lib/errors';

describe('canonical API errors', () => {
  test('keeps human detail separate from machine code and structured fields', () => {
    expect(errorEnvelope('Quota exceeded', {
      code: 'quota_exceeded',
      requestId: 'request-1',
      fields: { key: 'monthly_search_queries', limit: 10, used: 10 },
    })).toEqual({
      detail: 'Quota exceeded',
      code: 'quota_exceeded',
      request_id: 'request-1',
      fields: { key: 'monthly_search_queries', limit: 10, used: 10 },
    });
  });

  test('preserves status, headers, and the canonical JSON envelope', async () => {
    const response = errorResponse(429, 'Rate limit exceeded', {
      code: 'rate_limited',
      headers: { 'Retry-After': '3' },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('3');
    expect(await response.json()).toEqual({
      detail: 'Rate limit exceeded',
      code: 'rate_limited',
    });
  });

  test('domain errors carry mapping data without depending on Hono', () => {
    const error = new AppError(409, 'slug_taken', 'Slug is already in use');
    expect(error).toBeInstanceOf(Error);
    expect({ status: error.status, code: error.code, message: error.message }).toEqual({
      status: 409,
      code: 'slug_taken',
      message: 'Slug is already in use',
    });
  });
});
