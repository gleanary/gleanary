import { describe, it, expect } from 'vitest';
import { MAX_UPLOAD_BYTES, validatePdfUpload } from '@/lib/upload-validation';

function makeFile(name: string, type: string, size: number): File {
  const blob = new Blob([new Uint8Array(size)], { type });
  return new File([blob], name, { type });
}

describe('validatePdfUpload', () => {
  it('returns null for a valid PDF with correct MIME type', () => {
    const file = makeFile('doc.pdf', 'application/pdf', 1000);
    expect(validatePdfUpload(file)).toBeNull();
  });

  it('returns null for a .pdf extension with wrong MIME (extension fallback)', () => {
    const file = makeFile('doc.pdf', 'application/octet-stream', 1000);
    expect(validatePdfUpload(file)).toBeNull();
  });

  it('returns error for non-PDF MIME and non-.pdf extension', () => {
    const file = makeFile(
      'doc.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      1000,
    );
    expect(validatePdfUpload(file)).toBe('Only PDF files are supported.');
  });

  it('returns null for file exactly at the 50MB boundary', () => {
    const file = makeFile('doc.pdf', 'application/pdf', MAX_UPLOAD_BYTES);
    expect(validatePdfUpload(file)).toBeNull();
  });

  it('returns size error for file 1 byte over 50MB', () => {
    const file = makeFile('doc.pdf', 'application/pdf', MAX_UPLOAD_BYTES + 1);
    expect(validatePdfUpload(file)).toMatch(/exceeds 50MB/);
  });

  it('error message includes the actual file size in MB', () => {
    const size = 55 * 1024 * 1024;
    const file = makeFile('doc.pdf', 'application/pdf', size);
    const msg = validatePdfUpload(file);
    expect(msg).toContain('55.0MB');
  });
});
