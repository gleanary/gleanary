export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Returns true when a file is a PDF by MIME type or extension. */
export function isPdfFile(file: File): boolean {
  return file.type.includes('pdf') || file.name.endsWith('.pdf');
}

/**
 * Validates a file for PDF upload — checks MIME type/extension and size.
 * This is a client-side UX check; the server enforces the same limits authoritatively.
 * @param file - The File object to validate
 * @returns An error message string, or null if the file is acceptable
 */
export function validatePdfUpload(file: File): string | null {
  if (!file.type.includes('pdf') && !file.name.endsWith('.pdf'))
    return 'Only PDF files are supported.';
  if (file.size > MAX_UPLOAD_BYTES)
    return `File exceeds 50MB (${(file.size / 1024 / 1024).toFixed(1)}MB). Compress, split, or re-export at lower DPI.`;
  return null;
}
