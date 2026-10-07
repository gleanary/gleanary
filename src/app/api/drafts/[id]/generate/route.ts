import { NextRequest, NextResponse } from 'next/server';
import { generateDraftSchema, parseIdParam } from '@/lib/validators';
import { getDraftOrThrow } from '@/lib/db-helpers';
import { handleApiError } from '@/lib/api-error-handler';
import { sseEvent, SSE_HEADERS } from '@/lib/sse';
import { generateDraft } from '@/lib/content-generation';
import { emitUsageChanged } from '@/lib/usage-events';
import { DEFAULT_DRAFT_MODEL, DRAFT_MODEL_IDS, type DraftModelId } from '@/lib/models';
import { logger } from '@/lib/logger';
import type { RouteContext } from '@/types';

/**
 * POST /api/drafts/[id]/generate — Stream draft generation via SSE.
 * Events: `delta` (text chunk), `done` (success), `error` (failure).
 * Returns 409 if the draft was edited after its last generation and `force` is not true.
 * Aborting the response stream cancels the upstream Claude call; no DB write on abort or error.
 * @param req - NextRequest with optional JSON body `{ force?: boolean }`
 * @param context - Route context with draft ID
 * @returns SSE stream (200) or JSON error (404, 409, 422)
 */
export async function POST(req: NextRequest, context: RouteContext) {
  let id: number;
  let force: boolean;
  try {
    id = await parseIdParam(context);
    const body = (await req.json().catch(() => ({}))) as unknown;
    ({ force } = generateDraftSchema.parse(body));
  } catch (error) {
    return handleApiError(error, 'POST /api/drafts/[id]/generate');
  }

  let draft;
  try {
    draft = getDraftOrThrow(id);
  } catch (error) {
    return handleApiError(error, 'POST /api/drafts/[id]/generate');
  }

  if (!force && draft.lastEditedAt && draft.generatedAt && draft.lastEditedAt > draft.generatedAt) {
    logger.info(
      { event: 'draft_regenerate_blocked', draftId: id },
      'Regenerate blocked due to unsaved edits',
    );
    return NextResponse.json(
      { error: 'Draft has unsaved edits since last generation. Pass force: true to regenerate.' },
      { status: 409 },
    );
  }

  logger.info({ event: 'draft_generation_started', draftId: id }, 'Draft generation started');

  const abortController = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const model: DraftModelId = DRAFT_MODEL_IDS.includes(draft.model as DraftModelId)
          ? (draft.model as DraftModelId)
          : DEFAULT_DRAFT_MODEL;
        for await (const event of generateDraft(id, {
          abortSignal: abortController.signal,
          model,
        })) {
          if (abortController.signal.aborted) break;
          if (event.type === 'chunk') {
            controller.enqueue(sseEvent('delta', { text: event.text }));
          } else if (event.type === 'done') {
            controller.enqueue(sseEvent('done', {}));
            emitUsageChanged();
            logger.info(
              { event: 'draft_generation_completed', draftId: id },
              'Draft generation completed',
            );
          } else if (event.type === 'error') {
            controller.enqueue(sseEvent('error', { error: event.message }));
            logger.error(
              { err: event.message, event: 'draft_generation_failed', draftId: id },
              'Draft generation failed',
            );
          }
        }
      } catch (err) {
        logger.error(
          { err, event: 'draft_generation_failed', draftId: id },
          'Draft generation stream error',
        );
        if (!abortController.signal.aborted) {
          controller.enqueue(
            sseEvent('error', {
              error: err instanceof Error ? err.message : 'Generation failed',
            }),
          );
        }
      } finally {
        try {
          controller.close();
        } catch {
          // close() throws TypeError if the stream was already cancelled
        }
      }
    },
    cancel() {
      abortController.abort();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
