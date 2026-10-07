import { NextRequest, NextResponse } from 'next/server';
import { getPdfHashFromPath, readPdf } from '@/lib/pdf-storage';
import { getArticleOrThrow } from '@/lib/db-helpers';
import { parseIdParam } from '@/lib/validators';
import { withRoute } from '@/lib/api-error-handler';
import type { RouteContext } from '@/types';

/**
 * GET /api/articles/[id]/original — Stream the original PDF for reader view.
 * Supports RFC 7233 Range requests for partial content (react-pdf requires this).
 * @param req - NextRequest, optionally with a Range header
 * @param context - Route context with id param
 * @returns PDF bytes with 200 (full) or 206 (partial), 404 if no PDF stored, 416 for bad range
 */
export const GET = withRoute(
  'GET /api/articles/[id]/original',
  async (req: NextRequest, context: RouteContext) => {
    const id = await parseIdParam(context);
    const article = getArticleOrThrow(id);

    if (!article.originalFilePath) {
      return NextResponse.json({ error: 'No original file for this article' }, { status: 404 });
    }

    const hash = getPdfHashFromPath(article.originalFilePath);
    const buf = await readPdf(hash);
    const total = buf.length;

    const rangeHeader = req.headers.get('range');
    if (rangeHeader) {
      const match = rangeHeader.match(/^bytes=(\d+)?-(\d+)?$/);
      if (match) {
        let start: number;
        let end: number;

        if (match[1] === undefined) {
          // bytes=-N (suffix range)
          const suffix = parseInt(match[2]!, 10);
          start = Math.max(0, total - suffix);
          end = total - 1;
        } else if (match[2] === undefined) {
          // bytes=N- (open-ended)
          start = parseInt(match[1], 10);
          end = total - 1;
        } else {
          // bytes=N-M
          start = parseInt(match[1], 10);
          end = parseInt(match[2], 10);
        }

        // RFC 7233: clamp end to total - 1 (a client may request beyond EOF).
        if (end > total - 1) end = total - 1;

        if (start >= total || start > end) {
          return new NextResponse(null, {
            status: 416,
            headers: { 'Content-Range': `bytes */${total}` },
          });
        }

        // buf.buffer is always a plain ArrayBuffer from readFile in Node.js
        const slicedBuf = buf.buffer.slice(
          buf.byteOffset + start,
          buf.byteOffset + end + 1,
        ) as ArrayBuffer;
        return new NextResponse(slicedBuf, {
          status: 206,
          headers: {
            'Content-Type': 'application/pdf',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${end}/${total}`,
            'Content-Length': String(end - start + 1),
          },
        });
      }
    }

    return new NextResponse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + total) as ArrayBuffer,
      {
        status: 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Accept-Ranges': 'bytes',
          'Content-Length': String(total),
        },
      },
    );
  },
);
