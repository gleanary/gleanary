import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExternalServiceError } from '@/lib/errors';

const mockGetConfig = vi.hoisted(() => vi.fn());
vi.mock('@/lib/settings', () => ({
  getConfig: mockGetConfig,
  SETTINGS_SCHEMA: {},
  ENCRYPTED_KEYS: new Set(),
  getSetting: vi.fn().mockReturnValue(null),
}));

const mockCallMistralOcr = vi.hoisted(() => vi.fn());
vi.mock('@/lib/mistral-ocr', () => ({
  callMistralOcr: mockCallMistralOcr,
}));

const mockStorePdfImage = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockDeletePdfImages = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@/lib/pdf-storage', () => ({
  storePdfImage: mockStorePdfImage,
  deletePdfImages: mockDeletePdfImages,
  isValidPdfImageName: (name: string) => /^img-\d+\.(png|jpe?g|webp)$/.test(name),
}));

import { processPdfWithMistral } from '@/lib/pdf-processor';

const FILE_PATH = '/data/originals/' + 'a'.repeat(64) + '.pdf';
const HASH = 'a'.repeat(64);
const ARTICLE_ID = 42;

beforeEach(() => {
  mockGetConfig.mockReset();
  mockCallMistralOcr.mockReset();
  mockStorePdfImage.mockClear();
  mockDeletePdfImages.mockClear();
});

describe('processPdfWithMistral', () => {
  it('returns ok:true with html/text/markdown on successful OCR', async () => {
    mockGetConfig.mockReturnValue('test-key');
    mockCallMistralOcr.mockResolvedValue({
      markdown: '# Doc\n\nBody text.',
      pagesProcessed: 1,
      model: 'mistral-ocr-4-0',
      images: [],
      pages: [{ index: 0, markdown: '# Doc\n\nBody text.' }],
    });

    const result = await processPdfWithMistral(FILE_PATH, HASH, ARTICLE_ID);

    if (!result.ok) throw new Error('expected ok:true');
    expect(result.html).toContain('<h1');
    expect(result.html).toContain('Doc');
    expect(result.text).toContain('Body text');
    expect(result.markdown).toBeTruthy();
    expect(result.wordCount).toBeGreaterThan(0);
    expect(result.pagesProcessed).toBe(1);
    expect(result.model).toBe('mistral-ocr-4-0');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns ok:false reason no_key when Mistral key is not configured', async () => {
    mockGetConfig.mockReturnValue(null);

    const result = await processPdfWithMistral(FILE_PATH, HASH, ARTICLE_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toBe('no_key');
    expect(mockCallMistralOcr).not.toHaveBeenCalled();
  });

  it('returns ok:false reason mistral_error when callMistralOcr throws', async () => {
    mockGetConfig.mockReturnValue('test-key');
    mockCallMistralOcr.mockRejectedValue(
      new ExternalServiceError('Mistral OCR', 'network down', 503),
    );

    const result = await processPdfWithMistral(FILE_PATH, HASH, ARTICLE_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toBe('mistral_error');
    expect(result.errorMessage).toContain('network down');
  });

  it('returns ok:false reason empty_markdown when OCR yields no content', async () => {
    mockGetConfig.mockReturnValue('test-key');
    mockCallMistralOcr.mockResolvedValue({
      markdown: '',
      pagesProcessed: 1,
      model: 'mistral-ocr-4-0',
      images: [],
      pages: [{ index: 0, markdown: '' }],
    });

    const result = await processPdfWithMistral(FILE_PATH, HASH, ARTICLE_ID);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected ok:false');
    expect(result.reason).toBe('empty_markdown');
  });

  it('stores valid images and rewrites refs to API URLs', async () => {
    mockGetConfig.mockReturnValue('test-key');
    const fakeBase64 = Buffer.from('fake-png-data').toString('base64');
    mockCallMistralOcr.mockResolvedValue({
      markdown: '![](img-0.png) some text',
      pagesProcessed: 1,
      model: 'mistral-ocr-4-0',
      images: [{ id: 'img-0.png', image_base64: fakeBase64 }],
      pages: [{ index: 0, markdown: '![](img-0.png) some text', images: [] }],
    });

    const result = await processPdfWithMistral(FILE_PATH, HASH, ARTICLE_ID);

    if (!result.ok) throw new Error('expected ok:true');
    expect(mockDeletePdfImages).toHaveBeenCalledWith(HASH);
    expect(mockStorePdfImage).toHaveBeenCalledWith(HASH, 'img-0.png', expect.any(Buffer));
    expect(result.html).toContain(`/api/articles/${ARTICLE_ID}/images/img-0.png`);
  });

  it('drops orphan image refs not in the stored set', async () => {
    mockGetConfig.mockReturnValue('test-key');
    mockCallMistralOcr.mockResolvedValue({
      markdown: '![](img-99.png) leftover text',
      pagesProcessed: 1,
      model: 'mistral-ocr-4-0',
      images: [],
      pages: [{ index: 0, markdown: '![](img-99.png) leftover text', images: [] }],
    });

    const result = await processPdfWithMistral(FILE_PATH, HASH, ARTICLE_ID);

    if (!result.ok) throw new Error('expected ok:true');
    expect(result.html).not.toContain('img-99.png');
    expect(result.text).toContain('leftover text');
  });

  it('splices Mistral HTML tables at positional markers', async () => {
    mockGetConfig.mockReturnValue('test-key');
    mockCallMistralOcr.mockResolvedValue({
      markdown: 'before [tbl-0.html](tbl-0.html) after',
      pagesProcessed: 1,
      model: 'mistral-ocr-4-0',
      images: [],
      pages: [
        {
          index: 0,
          markdown: 'before [tbl-0.html](tbl-0.html) after',
          tables: [{ id: 'tbl-0.html', html: '<table><tr><td>cell</td></tr></table>' }],
        },
      ],
    });

    const result = await processPdfWithMistral(FILE_PATH, HASH, ARTICLE_ID);

    if (!result.ok) throw new Error('expected ok:true');
    expect(result.html).toContain('<table>');
    expect(result.html).toContain('cell');
  });
});
