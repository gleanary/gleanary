import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { parseIdParam } from '@/lib/validators';
import { isValidPdfImageName, readPdfImage } from '@/lib/pdf-storage';
import { withRoute } from '@/lib/api-error-handler';

type ImageRouteContext = { params: Promise<{ id: string; name: string }> };

/**
 * GET /api/articles/[id]/images/[name] — Serve a PDF-embedded image stored on disk.
 * Images are saved during Mistral OCR cleanup and addressed by content hash.
 * @param req - NextRequest
 * @param context - Route context with id and name params
 * @returns Image bytes with appropriate Content-Type, 404 if missing, 422 if name is invalid
 */
export const GET = withRoute(
  'GET /api/articles/[id]/images/[name]',
  async (_req: NextRequest, context: ImageRouteContext) => {
    const { name } = await context.params;
    const articleId = await parseIdParam(context);

    if (!isValidPdfImageName(name)) {
      return NextResponse.json({ error: 'Invalid image name' }, { status: 422 });
    }

    const article = db
      .select({ contentHash: articles.contentHash })
      .from(articles)
      .where(eq(articles.id, articleId))
      .get();
    if (!article?.contentHash) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const buf = await readPdfImage(article.contentHash, name);
    if (!buf) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const contentType = name.endsWith('.png') ? 'image/png' : 'image/jpeg';

    return new NextResponse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) as ArrayBuffer,
      {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Length': String(buf.length),
        },
      },
    );
  },
);
