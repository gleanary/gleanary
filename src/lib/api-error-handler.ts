import 'server-only';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { DuplicateError, ExternalServiceError, NotFoundError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

/**
 * Shared error handler for API routes. Maps known error types to appropriate HTTP responses.
 * @param error - The caught error
 * @param route - Route identifier for logging (e.g., 'POST /api/articles')
 * @returns NextResponse with appropriate status code and error message
 */
export function handleApiError(error: unknown, route: string): NextResponse {
  if (error instanceof z.ZodError) {
    return NextResponse.json(
      { error: 'Validation failed', details: error.issues },
      { status: 422 },
    );
  }
  if (error instanceof ValidationError) {
    return NextResponse.json({ error: error.message }, { status: 422 });
  }
  if (error instanceof NotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof DuplicateError) {
    return NextResponse.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ExternalServiceError) {
    logger.error({ err: error, route }, 'External service failed');
    return NextResponse.json({ error: error.message }, { status: error.statusCode });
  }
  // Malformed JSON body
  if (error instanceof SyntaxError && error.message.includes('JSON')) {
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }
  // SQLite UNIQUE constraint violation (fallback for uncaught duplicates)
  if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
    return NextResponse.json({ error: 'Resource already exists' }, { status: 409 });
  }

  logger.error({ err: error, route }, 'Request failed');
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/**
 * Wraps an API route handler in the shared try/catch shell so that any thrown
 * error is funneled through {@link handleApiError} with the given route label.
 * The handler's successful result is returned untouched.
 * @param route - Route identifier for logging (e.g., 'POST /api/articles')
 * @param handler - The route handler to wrap
 * @returns A handler with identical arguments that maps thrown errors to responses
 */
export function withRoute<Args extends unknown[]>(
  route: string,
  handler: (...args: Args) => Promise<NextResponse | Response>,
): (...args: Args) => Promise<NextResponse | Response> {
  return async (...args: Args): Promise<NextResponse | Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      return handleApiError(error, route);
    }
  };
}
