import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { preflightPdf } from '@/lib/pdf-preflight';
import { EncryptedPdfError, ParsingError } from '@/lib/errors';

const FIXTURES = join(__dirname, '../mocks/fixtures/pdfs');

function loadFixture(name: string): Buffer {
  return readFileSync(join(FIXTURES, name));
}

function fixturePath(name: string): string {
  return join(FIXTURES, name);
}

describe('preflightPdf', () => {
  it('returns pageCount from a single-page PDF', async () => {
    const result = await preflightPdf(loadFixture('minimal-text.pdf'));
    expect(result.pageCount).toBe(1);
  });

  it('returns pageCount from a multi-page PDF', async () => {
    const result = await preflightPdf(loadFixture('multi-page-text.pdf'));
    expect(result.pageCount).toBe(3);
  });

  it('returns null title/author/creationDate when /Info is empty', async () => {
    const result = await preflightPdf(loadFixture('minimal-text.pdf'));
    expect(result.title).toBeNull();
    expect(result.author).toBeNull();
    expect(result.creationDate).toBeNull();
  });

  it('throws EncryptedPdfError for password-protected PDFs', async () => {
    await expect(preflightPdf(loadFixture('encrypted.pdf'))).rejects.toBeInstanceOf(
      EncryptedPdfError,
    );
  });

  it('throws ParsingError for a corrupted PDF', async () => {
    await expect(preflightPdf(loadFixture('corrupted.pdf'))).rejects.toBeInstanceOf(ParsingError);
  });

  it('does not extract text content (no body field returned)', async () => {
    const result = await preflightPdf(loadFixture('multi-page-text.pdf'));
    // Preflight contract: only metadata, no text
    expect(result).toEqual({
      pageCount: expect.any(Number),
      title: null,
      author: null,
      creationDate: null,
    });
  });

  it('accepts a file path string and reads the PDF from disk', async () => {
    const result = await preflightPdf(fixturePath('minimal-text.pdf'));
    expect(result.pageCount).toBe(1);
  });

  it('throws EncryptedPdfError for an encrypted PDF given as file path', async () => {
    await expect(preflightPdf(fixturePath('encrypted.pdf'))).rejects.toBeInstanceOf(
      EncryptedPdfError,
    );
  });

  it('throws ParsingError for a corrupted PDF given as file path', async () => {
    await expect(preflightPdf(fixturePath('corrupted.pdf'))).rejects.toBeInstanceOf(ParsingError);
  });
});
