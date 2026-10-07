import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { articles } from '@/db/schema';
import { config } from '@/config';
import { logger } from '@/lib/logger';
import { NotFoundError, ValidationError } from '@/lib/errors';
import { handleApiError } from '@/lib/api-error-handler';
import { ttsStreamSchema, ttsArticleIdSchema } from '@/lib/validators';
import { getConfig } from '@/lib/settings';
import { prepareArticleFromHtml, detectLanguage } from '@/lib/tts-text';
import { synthesizeArticle } from '@/lib/tts';
import { cachedSynthesizeArticle } from '@/lib/tts-cache';
import { sseEvent, SSE_HEADERS } from '@/lib/sse';
import type { TTSOptions, TTSRouteContext } from '@/types';

/**
 * GET /api/tts/[articleId]
 * Streams TTS audio and word timestamps for an article via Server-Sent Events.
 */
export async function GET(req: NextRequest, context: TTSRouteContext) {
  // Validate articleId
  let articleId: number;
  try {
    articleId = ttsArticleIdSchema.parse((await context.params).articleId);
  } catch {
    return NextResponse.json({ error: 'Invalid article ID' }, { status: 422 });
  }

  // Validate query params
  let params: z.infer<typeof ttsStreamSchema>;
  try {
    params = ttsStreamSchema.parse(Object.fromEntries(req.nextUrl.searchParams));
  } catch (error) {
    return handleApiError(error, `GET /api/tts/${articleId}`);
  }

  // Check TTS is configured (runtime check for settings-table or env var)
  if (!getConfig('inworld_api_key') && process.env.MOCK_TTS !== 'true') {
    return NextResponse.json({ error: 'TTS not configured' }, { status: 503 });
  }

  // Load article
  const article = db
    .select({
      contentText: articles.contentText,
      contentHtml: articles.contentHtml,
      title: articles.title,
    })
    .from(articles)
    .where(eq(articles.id, articleId))
    .get();

  if (!article) {
    return handleApiError(new NotFoundError('Article', articleId), `GET /api/tts/${articleId}`);
  }

  if (!article.contentText?.trim() && !article.contentHtml?.trim()) {
    return handleApiError(
      new ValidationError('Article has no text content for TTS'),
      `GET /api/tts/${articleId}`,
    );
  }

  // Prepare text — prefer HTML extraction for accurate DOM block alignment
  const paragraphs = prepareArticleFromHtml(article.contentHtml ?? '', article.contentText ?? '');
  const language = detectLanguage(article.contentText ?? '');

  // Resolve voice
  const voiceId =
    params.voiceId ??
    (language === 'fr' ? getConfig('inworld_voice_fr') : getConfig('inworld_voice_en'));

  const ttsOptions: TTSOptions = {
    voiceId,
    modelId: config.tts.model,
    speed: params.speed,
    audioEncoding: config.tts.audioEncoding,
    sampleRateHertz: config.tts.sampleRate,
  };

  logger.info(
    {
      event: 'tts_stream_start',
      articleId,
      language,
      voiceId,
      speed: params.speed,
      totalParagraphs: paragraphs.length,
    },
    'Starting TTS stream',
  );

  // Create SSE stream with abort signal for client disconnection
  const abortController = new AbortController();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        // Send metadata
        controller.enqueue(
          sseEvent('metadata', {
            totalParagraphs: paragraphs.length,
            totalWords: paragraphs.reduce((sum, p) => sum + p.wordCount, 0),
            articleTitle: article.title,
            language,
          }),
        );

        let totalDuration = 0;

        // Buffer chunks per paragraph so the client receives one combined audio event
        let currentParaIndex = -1;
        let audioChunks: string[] = [];
        let allWords: string[] = [];
        let allStartTimes: number[] = [];
        let allEndTimes: number[] = [];

        const flushParagraph = (paragraphIndex: number) => {
          if (audioChunks.length === 0) return;

          // Concatenate base64 audio: decode each chunk, combine, re-encode
          const buffers = audioChunks.map((b64) => {
            const binary = atob(b64);
            const bytes = new Uint8Array(binary.length);
            for (let j = 0; j < binary.length; j++) {
              bytes[j] = binary.charCodeAt(j);
            }
            return bytes;
          });
          const totalLen = buffers.reduce((sum, b) => sum + b.length, 0);
          const combined = new Uint8Array(totalLen);
          let offset = 0;
          for (const buf of buffers) {
            combined.set(buf, offset);
            offset += buf.length;
          }
          // btoa from Uint8Array
          let combinedB64 = '';
          const CHUNK_SIZE = 8192;
          for (let j = 0; j < combined.length; j += CHUNK_SIZE) {
            combinedB64 += String.fromCharCode(
              ...combined.subarray(j, Math.min(j + CHUNK_SIZE, combined.length)),
            );
          }
          combinedB64 = btoa(combinedB64);

          controller.enqueue(
            sseEvent('audio', {
              paragraphIndex,
              audioContent: combinedB64,
              format: 'mp3',
              words: allWords,
              startTimes: allStartTimes,
              endTimes: allEndTimes,
            }),
          );

          // Track duration
          if (allEndTimes.length > 0) {
            const lastEnd = allEndTimes[allEndTimes.length - 1] ?? 0;
            totalDuration += lastEnd;
          }

          // Reset buffers
          audioChunks = [];
          allWords = [];
          allStartTimes = [];
          allEndTimes = [];
        };

        const generator = config.tts.cache.enabled
          ? cachedSynthesizeArticle(
              articleId,
              paragraphs,
              ttsOptions,
              params.startParagraph,
              abortController.signal,
            )
          : synthesizeArticle(
              paragraphs,
              ttsOptions,
              params.startParagraph,
              abortController.signal,
            );

        for await (const event of generator) {
          if (event.type === 'chunk') {
            const { data } = event;
            currentParaIndex = data.paragraphIndex;
            audioChunks.push(data.audioContent);

            // Accumulate word timestamps (Inworld timestamps are already cumulative within each API call)
            allWords.push(...data.words);
            allStartTimes.push(...data.startTimes);
            allEndTimes.push(...data.endTimes);
          } else if (event.type === 'paragraph-complete') {
            flushParagraph(currentParaIndex);
            controller.enqueue(
              sseEvent('paragraph-complete', {
                paragraphIndex: event.paragraphIndex,
              }),
            );
          }
        }

        controller.enqueue(sseEvent('complete', { totalDuration }));

        logger.info(
          { event: 'tts_stream_complete', articleId, totalDuration },
          'TTS stream completed',
        );
      } catch (error) {
        logger.error({ err: error, event: 'tts_stream_error', articleId }, 'TTS stream failed');
        controller.enqueue(
          sseEvent('error', {
            message: error instanceof Error ? error.message : 'TTS synthesis failed',
          }),
        );
      } finally {
        controller.close();
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, {
    headers: SSE_HEADERS,
  });
}
