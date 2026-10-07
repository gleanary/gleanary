import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';

// Mock logger to prevent actual log output during tests
vi.mock('@/lib/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { NextResponse } from 'next/server';
import { handleApiError, withRoute } from '@/lib/api-error-handler';
import { ValidationError, NotFoundError, DuplicateError, ExternalServiceError } from '@/lib/errors';
import { logger } from '@/lib/logger';

describe('handleApiError', () => {
  it('returns 422 for ZodError', async () => {
    const schema = z.object({ name: z.string() });
    const result = schema.safeParse({ name: 123 });
    const zodError = (result as { success: false; error: z.ZodError }).error;
    const response = handleApiError(zodError, 'POST /api/test');
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe('Validation failed');
    expect(body.details).toBeDefined();
  });

  it('returns 422 for ValidationError', async () => {
    const response = handleApiError(new ValidationError('Invalid input'), 'POST /api/test');
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body.error).toBe('Invalid input');
  });

  it('returns 404 for NotFoundError', async () => {
    const response = handleApiError(new NotFoundError('Article', 42), 'GET /api/articles/42');
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain('Article');
  });

  it('returns 409 for DuplicateError', async () => {
    const response = handleApiError(new DuplicateError('Article', 'url'), 'POST /api/articles');
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toContain('already exists');
  });

  it('returns 503 for ExternalServiceError (default statusCode)', async () => {
    const response = handleApiError(
      new ExternalServiceError('Claude API', 'rate limited'),
      'POST /api/ai/summarize',
    );
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('Claude API: rate limited');
  });

  it('returns 400 for JSON SyntaxError', async () => {
    const error = new SyntaxError('Unexpected token in JSON');
    const response = handleApiError(error, 'POST /api/test');
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid JSON in request body');
  });

  it('returns 409 for SQLite UNIQUE constraint violation', async () => {
    const error = new Error('UNIQUE constraint failed: articles.url');
    const response = handleApiError(error, 'POST /api/articles');
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe('Resource already exists');
  });

  it('returns 500 for unknown errors', async () => {
    const response = handleApiError(new Error('Something broke'), 'GET /api/test');
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Internal server error');
  });

  it('does not leak internal error details in 500 response', async () => {
    const response = handleApiError(
      new Error('database connection string exposed'),
      'GET /api/test',
    );
    const body = await response.json();
    expect(body.error).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('database connection string');
  });
});

describe('withRoute', () => {
  it('passes the handler result through untouched on success', async () => {
    const expected = NextResponse.json({ ok: true }, { status: 201 });
    const handler = vi.fn(async (_a: string, _b: number) => expected);
    const wrapped = withRoute('POST /api/test', handler);

    const response = await wrapped('a', 42);

    expect(response).toBe(expected);
    expect(response.status).toBe(201);
    expect(handler).toHaveBeenCalledWith('a', 42);
  });

  it('maps a thrown NotFoundError to 404 via handleApiError', async () => {
    const wrapped = withRoute('GET /api/articles/42', async () => {
      throw new NotFoundError('Article', 42);
    });

    const response = await wrapped();

    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body.error).toContain('Article');
  });

  it('forwards the route label to handleApiError logging on unknown errors', async () => {
    const errorSpy = vi.mocked(logger.error);
    errorSpy.mockClear();
    const wrapped = withRoute('DELETE /api/widgets/7', async () => {
      throw new Error('boom');
    });

    const response = await wrapped();

    expect(response.status).toBe(500);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ route: 'DELETE /api/widgets/7' }),
      'Request failed',
    );
  });
});
