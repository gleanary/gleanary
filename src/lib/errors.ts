/** Thrown when input validation fails (Zod, etc.) */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Thrown when a requested resource is not found */
export class NotFoundError extends Error {
  constructor(resource: string, id?: string | number) {
    super(id ? `${resource} with id ${id} not found` : `${resource} not found`);
    this.name = 'NotFoundError';
  }
}

/** Thrown when an operation would create a duplicate */
export class DuplicateError extends Error {
  constructor(resource: string, field?: string) {
    super(field ? `${resource} with this ${field} already exists` : `Duplicate ${resource}`);
    this.name = 'DuplicateError';
  }
}

/** Thrown when an external service call fails (fetch, Claude API, etc.) */
export class ExternalServiceError extends Error {
  /** HTTP status code to return to the client. Defaults to 503. */
  readonly statusCode: number;

  constructor(service: string, message: string, statusCode = 503) {
    super(`${service}: ${message}`);
    this.name = 'ExternalServiceError';
    this.statusCode = statusCode;
  }
}

/** Thrown when a PDF is password-protected and cannot be extracted */
export class EncryptedPdfError extends Error {
  constructor() {
    super('PDF is encrypted');
    this.name = 'EncryptedPdfError';
  }
}

/** Thrown when a PDF cannot be parsed (corrupted, malformed, or unsupported structure) */
export class ParsingError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ParsingError';
  }
}
