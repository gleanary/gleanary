import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

vi.mock('@/lib/pdf-storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pdf-storage')>();
  return { ...actual, readPdfImage: vi.fn() };
});

import { articles } from '@/db/schema';
import { readPdfImage } from '@/lib/pdf-storage';
import { GET as getImage } from '@/app/api/articles/[id]/images/[name]/route';

const mockReadPdfImage = readPdfImage as ReturnType<typeof vi.fn>;

function imageRouteParams(id: number, name: string) {
  return { params: Promise.resolve({ id: String(id), name }) };
}

const CONTENT_HASH = 'f'.repeat(64);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);

describe('GET /api/articles/[id]/images/[name]', () => {
  let articleId: number;

  beforeEach(() => {
    const { db } = dbMock.setup();
    mockReadPdfImage.mockReset();

    // Insert a PDF article with contentHash
    const row = db
      .insert(articles)
      .values({
        url: 'https://example.com/pdf-image-test',
        title: 'PDF Image Test',
        originalFilePath: `/data/originals/${CONTENT_HASH}.pdf`,
        contentHash: CONTENT_HASH,
      })
      .returning()
      .get();
    articleId = row.id;
  });

  it('returns 200 with correct bytes and Content-Type: image/jpeg for a jpeg', async () => {
    mockReadPdfImage.mockResolvedValue(JPEG_BYTES);

    const req = new NextRequest(
      `http://localhost:3000/api/articles/${articleId}/images/img-0.jpeg`,
    );
    const res = await getImage(req, imageRouteParams(articleId, 'img-0.jpeg'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Content-Length')).toBe(String(JPEG_BYTES.length));

    const body = Buffer.from(await res.arrayBuffer());
    expect(body).toEqual(JPEG_BYTES);
  });

  it('returns 200 with Content-Type: image/jpeg for a jpg extension', async () => {
    mockReadPdfImage.mockResolvedValue(JPEG_BYTES);

    const req = new NextRequest(`http://localhost:3000/api/articles/${articleId}/images/img-0.jpg`);
    const res = await getImage(req, imageRouteParams(articleId, 'img-0.jpg'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
  });

  it('returns 200 with Content-Type: image/png for a png', async () => {
    mockReadPdfImage.mockResolvedValue(PNG_BYTES);

    const req = new NextRequest(`http://localhost:3000/api/articles/${articleId}/images/img-0.png`);
    const res = await getImage(req, imageRouteParams(articleId, 'img-0.png'));

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
  });

  it('returns Cache-Control: public, max-age=31536000, immutable on 200', async () => {
    mockReadPdfImage.mockResolvedValue(JPEG_BYTES);

    const req = new NextRequest(
      `http://localhost:3000/api/articles/${articleId}/images/img-0.jpeg`,
    );
    const res = await getImage(req, imageRouteParams(articleId, 'img-0.jpeg'));

    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('returns 404 with generic body when image file is missing', async () => {
    mockReadPdfImage.mockResolvedValue(null);

    const req = new NextRequest(
      `http://localhost:3000/api/articles/${articleId}/images/img-0.jpeg`,
    );
    const res = await getImage(req, imageRouteParams(articleId, 'img-0.jpeg'));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found' });
  });

  it('returns identical 404 body for missing article vs missing image file', async () => {
    // Missing image file
    mockReadPdfImage.mockResolvedValue(null);
    const req1 = new NextRequest(
      `http://localhost:3000/api/articles/${articleId}/images/img-0.jpeg`,
    );
    const res1 = await getImage(req1, imageRouteParams(articleId, 'img-0.jpeg'));

    // Non-existent article
    const req2 = new NextRequest(`http://localhost:3000/api/articles/9999/images/img-0.jpeg`);
    const res2 = await getImage(req2, imageRouteParams(9999, 'img-0.jpeg'));

    expect(res1.status).toBe(404);
    expect(res2.status).toBe(404);
    expect(await res1.json()).toEqual(await res2.json());
  });

  it('returns 404 for non-PDF article (no contentHash)', async () => {
    const db = dbMock.mock.db!;
    const nonPdfRow = db
      .insert(articles)
      .values({ url: 'https://example.com/non-pdf', title: 'Non-PDF' })
      .returning()
      .get();

    const req = new NextRequest(
      `http://localhost:3000/api/articles/${nonPdfRow.id}/images/img-0.jpeg`,
    );
    const res = await getImage(req, imageRouteParams(nonPdfRow.id, 'img-0.jpeg'));

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Not found' });
  });

  it('returns 422 for invalid name: traversal attempt', async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/articles/${articleId}/images/../../etc/passwd`,
    );
    const res = await getImage(req, imageRouteParams(articleId, '../../etc/passwd'));

    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body).toEqual({ error: 'Invalid image name' });
    expect(mockReadPdfImage).not.toHaveBeenCalled();
  });

  it('returns 422 for invalid name: wrong extension', async () => {
    const req = new NextRequest(`http://localhost:3000/api/articles/${articleId}/images/img-0.gif`);
    const res = await getImage(req, imageRouteParams(articleId, 'img-0.gif'));

    expect(res.status).toBe(422);
  });

  it('returns 422 for invalid name: uppercase extension', async () => {
    const req = new NextRequest(
      `http://localhost:3000/api/articles/${articleId}/images/img-0.JPEG`,
    );
    const res = await getImage(req, imageRouteParams(articleId, 'img-0.JPEG'));

    expect(res.status).toBe(422);
  });
});
