/**
 * Content generation pipeline for Module 16 (Content Templates).
 *
 * Loads draft + thesis + highlights + research + voice context, assembles the
 * prompt, streams from Claude, and persists atomically on success. On error
 * or abort, no DB write happens, so the prior `drafts.content` is preserved.
 *
 * **Single-flight invariant (not enforced here)**: callers must ensure at most
 * one in-flight `generateDraft` per `draftId`. Two parallel calls will both
 * persist, last-write-wins. The API route in Phase 3.2 is responsible for
 * gating this.
 */

import 'server-only';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/db';
import {
  drafts,
  theses,
  highlights,
  thesisHighlights,
  thesisResearch,
  voiceProfile,
  voiceSamples,
} from '@/db/schema';
import { callClaudeStreaming } from '@/lib/ai';
import { getTemplate } from '@/lib/content-templates';
import type { DraftModelId } from '@/lib/models';
import { logger } from '@/lib/logger';
import { NotFoundError } from '@/lib/errors';
import type {
  Thesis,
  ThesisResearch,
  ThesisHighlightRole,
  VoiceSample,
  DraftContextSnapshot,
  TemplateId,
} from '@/types';
import { THESIS_HIGHLIGHT_ROLES } from '@/types';

// --- Types ---

export type StreamEvent =
  { type: 'chunk'; text: string } | { type: 'done' } | { type: 'error'; message: string };

export interface GenerateDraftOptions {
  abortSignal?: AbortSignal;
  model?: DraftModelId;
}

/** Minimal shape the prompt assembler needs — no article context or IDs. */
export interface HighlightForGeneration {
  text: string;
  note: string | null;
  role: ThesisHighlightRole;
}

/** Inputs shared by `buildUserPrompt` and `truncateUserPrompt`. */
export interface UserPromptInput {
  thesis: Thesis;
  highlightsByRole: Record<ThesisHighlightRole, HighlightForGeneration[]>;
  research: ThesisResearch[];
  angle: string | null;
}

// --- Constants ---

const MAX_OUTPUT_TOKENS = 8192;
const USER_PROMPT_CHAR_BUDGET = 60_000;
const MISSING_VOICE_FALLBACK = 'No voice profile available; follow template instructions only.';

const ROLE_LABEL: Record<ThesisHighlightRole, string> = {
  supporting: 'Supporting',
  opposing: 'Opposing',
  context: 'Context',
};

// --- Pure helpers ---

/**
 * Tokenizes a comma-separated channel hint string.
 * @param hint - Raw channel hint (may be null or empty)
 * @returns Array of lowercase, trimmed tokens
 */
function tokenizeHint(hint: string | null | undefined): string[] {
  if (!hint) return [];
  return hint
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => t.length > 0);
}

/**
 * Selects 1–2 voice samples that best match the template's channel hint.
 * If no sample's channel_hint overlaps the template's tokens, falls back to
 * the 2 most recent samples. Returns [] if the pool is empty.
 * @param samples - All available samples (order does not matter)
 * @param templateChannelHint - The template's channel_hint string
 * @returns Up to 2 samples, ordered newest-first
 */
export function selectSamples(samples: VoiceSample[], templateChannelHint: string): VoiceSample[] {
  if (samples.length === 0) return [];

  const templateTokens = new Set(tokenizeHint(templateChannelHint));
  const byCreatedDesc = [...samples].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (templateTokens.size > 0) {
    const matches = byCreatedDesc.filter((s) =>
      tokenizeHint(s.channelHint).some((t) => templateTokens.has(t)),
    );
    if (matches.length > 0) return matches.slice(0, 2);
  }

  return byCreatedDesc.slice(0, 2);
}

/**
 * Assembles the system prompt from voice profile, selected samples, and template instructions.
 * @param args - Profile markdown (or null), selected samples, and template instructions
 * @returns The concatenated system prompt
 */
export function buildSystemPrompt(args: {
  voiceProfile: string | null;
  samples: VoiceSample[];
  templateInstructions: string;
}): string {
  const sections: string[] = [];
  sections.push(
    args.voiceProfile && args.voiceProfile.trim().length > 0
      ? args.voiceProfile.trim()
      : MISSING_VOICE_FALLBACK,
  );

  for (const sample of args.samples) {
    sections.push(`## Sample: ${sample.title}\n\n${sample.content}`);
  }

  sections.push(args.templateInstructions);
  return sections.join('\n\n');
}

/**
 * Formats a single highlight as a bullet line.
 */
function formatHighlight(h: HighlightForGeneration): string {
  const base = `- "${h.text}"`;
  return h.note && h.note.trim().length > 0 ? `${base} — ${h.note.trim()}` : base;
}

/**
 * Assembles the user prompt from the thesis, highlights grouped by role, research, and angle.
 * @param args - Thesis, role-grouped highlights, research entries, and optional angle
 * @returns The concatenated user prompt
 */
export function buildUserPrompt(args: UserPromptInput): string {
  const { thesis, highlightsByRole, research, angle } = args;
  const parts: string[] = [];

  const claim = thesis.claim && thesis.claim.trim().length > 0 ? thesis.claim.trim() : thesis.title;
  parts.push(`# Thesis\n\n## Claim\n\n${claim}`);

  if (thesis.counterarguments && thesis.counterarguments.trim().length > 0) {
    parts.push(`## Counterarguments\n\n${thesis.counterarguments.trim()}`);
  }
  if (thesis.implications && thesis.implications.trim().length > 0) {
    parts.push(`## Implications\n\n${thesis.implications.trim()}`);
  }

  for (const role of THESIS_HIGHLIGHT_ROLES) {
    const bucket = highlightsByRole[role];
    if (bucket.length === 0) continue;
    const heading = `# ${ROLE_LABEL[role]} highlights`;
    const body = bucket.map(formatHighlight).join('\n');
    parts.push(`${heading}\n\n${body}`);
  }

  if (research.length > 0) {
    const body = research.map((r) => `## ${r.title}\n\n${r.content}`).join('\n\n');
    parts.push(`# Research\n\n${body}`);
  }

  if (angle && angle.trim().length > 0) {
    parts.push(`Angle for this piece: ${angle.trim()}`);
  }

  return parts.join('\n\n');
}

/**
 * Builds the user prompt and, if it exceeds the budget, drops or truncates
 * research entries until the prompt fits. Thesis fields, highlights, and the
 * angle line are kept intact — research is the only category truncated.
 * @param args - Same inputs as buildUserPrompt plus a character budget
 * @returns The (possibly truncated) prompt and a flag indicating truncation
 */
export function truncateUserPrompt(args: UserPromptInput & { budget: number }): {
  prompt: string;
  truncated: boolean;
} {
  const full = buildUserPrompt(args);
  if (full.length <= args.budget) return { prompt: full, truncated: false };

  for (let i = args.research.length - 1; i >= 0; i--) {
    const trial = buildUserPrompt({ ...args, research: args.research.slice(0, i) });
    if (trial.length <= args.budget) return { prompt: trial, truncated: true };
  }

  // Even with zero research we are still over budget — hand back what we have.
  // The system prompt is unbounded and the model will handle the oversize payload.
  const minimal = buildUserPrompt({ ...args, research: [] });
  return { prompt: minimal, truncated: true };
}

// --- Data loading ---

function parseSnapshot(raw: string | null): DraftContextSnapshot {
  if (!raw) return { highlightIds: [], researchIds: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<DraftContextSnapshot>;
    return {
      highlightIds: Array.isArray(parsed.highlightIds) ? parsed.highlightIds : [],
      researchIds: Array.isArray(parsed.researchIds) ? parsed.researchIds : [],
    };
  } catch {
    logger.warn({ event: 'draft_snapshot_parse_failed' }, 'Failed to parse context_snapshot JSON');
    return { highlightIds: [], researchIds: [] };
  }
}

function loadHighlightsByRole(
  thesisId: number,
  highlightIds: number[],
): Record<ThesisHighlightRole, HighlightForGeneration[]> {
  const empty: Record<ThesisHighlightRole, HighlightForGeneration[]> = {
    supporting: [],
    opposing: [],
    context: [],
  };
  if (highlightIds.length === 0) return empty;

  const rows = db
    .select({
      text: highlights.text,
      note: highlights.note,
      role: thesisHighlights.role,
    })
    .from(thesisHighlights)
    .innerJoin(highlights, eq(thesisHighlights.highlightId, highlights.id))
    .where(
      and(
        eq(thesisHighlights.thesisId, thesisId),
        inArray(thesisHighlights.highlightId, highlightIds),
      ),
    )
    .all();

  for (const row of rows) {
    empty[row.role].push({ text: row.text, note: row.note, role: row.role });
  }
  return empty;
}

function loadResearch(thesisId: number, researchIds: number[]): ThesisResearch[] {
  if (researchIds.length === 0) return [];
  return db
    .select()
    .from(thesisResearch)
    .where(and(eq(thesisResearch.thesisId, thesisId), inArray(thesisResearch.id, researchIds)))
    .orderBy(thesisResearch.id)
    .all();
}

function loadVoiceContext(templateChannelHint: string): {
  profileMarkdown: string | null;
  samples: VoiceSample[];
} {
  const profile = db.select().from(voiceProfile).where(eq(voiceProfile.userId, 1)).get();
  if (!profile) return { profileMarkdown: null, samples: [] };

  const allSamples = db
    .select()
    .from(voiceSamples)
    .where(eq(voiceSamples.profileId, profile.id))
    .orderBy(desc(voiceSamples.createdAt))
    .all();

  return {
    profileMarkdown: profile.profile,
    samples: selectSamples(allSamples, templateChannelHint),
  };
}

// --- Streaming ---

interface ChunkQueue {
  push: (chunk: string) => void;
  next: () => Promise<string | null>;
  close: () => void;
}

/**
 * Creates a FIFO queue that decouples the Anthropic `onText` callback from the
 * async generator's iteration. Producers push chunks; the consumer awaits each.
 * `close()` signals the end of stream — subsequent `next()` calls resolve to null.
 */
function createChunkQueue(): ChunkQueue {
  const queue: string[] = [];
  let pending: ((v: string | null) => void) | null = null;
  let closed = false;

  return {
    push(chunk) {
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve(chunk);
      } else {
        queue.push(chunk);
      }
    },
    next() {
      if (queue.length > 0) return Promise.resolve(queue.shift()!);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        pending = resolve;
      });
    },
    close() {
      closed = true;
      if (pending) {
        const resolve = pending;
        pending = null;
        resolve(null);
      }
    },
  };
}

// --- Generator ---

/**
 * Async generator producing a stream of events while generating a draft.
 * Yields `chunk` events as text arrives from Claude, then `done` on success or
 * `error` on failure/abort. On any non-success outcome, no database write
 * happens and the draft's previous `content` is preserved.
 *
 * @param draftId - The id of the draft row to generate
 * @param opts - Optional abort signal to cancel the in-flight Anthropic request
 */
export async function* generateDraft(
  draftId: number,
  opts?: GenerateDraftOptions,
): AsyncIterable<StreamEvent> {
  const logCtx: Record<string, unknown> = { draftId };

  // 1. Load draft
  const draft = db.select().from(drafts).where(eq(drafts.id, draftId)).get();
  if (!draft) {
    const err = new NotFoundError('Draft', draftId);
    logger.error({ ...logCtx, err, event: 'draft_generation_failed' }, err.message);
    yield { type: 'error', message: err.message };
    return;
  }
  logCtx.thesisId = draft.thesisId;
  logCtx.templateId = draft.templateId;

  // 2. Load thesis (defensive — normally guaranteed by cascade-on-delete)
  const thesis = db.select().from(theses).where(eq(theses.id, draft.thesisId)).get();
  if (!thesis) {
    const err = new NotFoundError('Thesis', draft.thesisId);
    logger.error({ ...logCtx, err, event: 'draft_generation_failed' }, err.message);
    yield { type: 'error', message: err.message };
    return;
  }

  try {
    // 3. Load filtered highlights, research, voice context
    const snapshot = parseSnapshot(draft.contextSnapshot);
    const highlightsByRole = loadHighlightsByRole(thesis.id, snapshot.highlightIds);
    const research = loadResearch(thesis.id, snapshot.researchIds);
    const template = getTemplate(draft.templateId as TemplateId);
    const { profileMarkdown, samples } = loadVoiceContext(template.channelHint);
    logCtx.sampleCount = samples.length;
    logCtx.hasVoiceProfile = profileMarkdown !== null;

    // 4. Assemble prompts
    const systemPrompt = buildSystemPrompt({
      voiceProfile: profileMarkdown,
      samples,
      templateInstructions: template.instructions,
    });
    const { prompt: userPrompt, truncated } = truncateUserPrompt({
      thesis,
      highlightsByRole,
      research,
      angle: draft.angle,
      budget: USER_PROMPT_CHAR_BUDGET,
    });
    if (truncated) {
      logger.warn(
        { ...logCtx, event: 'draft_prompt_truncated', userPromptChars: userPrompt.length },
        'User prompt exceeded budget; truncated research entries',
      );
    }
    logCtx.systemPromptChars = systemPrompt.length;
    logCtx.userPromptChars = userPrompt.length;

    // 5. Stream from Claude
    const queue = createChunkQueue();
    const streamPromise = callClaudeStreaming({
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      model: opts?.model ?? (draft.model as DraftModelId),
      maxTokens: MAX_OUTPUT_TOKENS,
      ctx: { feature: 'draft_generation', resourceType: 'draft', resourceId: draftId },
      abortSignal: opts?.abortSignal,
      onText(delta) {
        queue.push(delta);
      },
    });

    // Close the queue when the stream resolves or rejects so the drain loop exits.
    const settled = streamPromise
      .then(
        (value) => ({ ok: true as const, value }),
        (err: unknown) => ({ ok: false as const, err }),
      )
      .finally(() => queue.close());

    // 6. Drain chunks
    while (true) {
      const chunk = await queue.next();
      if (chunk === null) break;
      yield { type: 'chunk', text: chunk };
    }

    const outcome = await settled;
    if (!outcome.ok) {
      const aborted = opts?.abortSignal?.aborted === true;
      const message = aborted
        ? 'Generation aborted'
        : outcome.err instanceof Error
          ? outcome.err.message
          : 'Stream failed';
      logger.error(
        { ...logCtx, err: outcome.err, event: 'draft_generation_failed', aborted },
        'Draft generation failed',
      );
      yield { type: 'error', message };
      return;
    }

    // 7. Persist atomically (single UPDATE is atomic in SQLite).
    // Distinct log event so token spend is attributable when the Claude call
    // succeeded but the DB write failed (e.g. SQLITE_BUSY).
    try {
      db.update(drafts)
        .set({
          content: outcome.value.text,
          generatedAt: sql`(datetime('now'))`,
          lastEditedAt: null,
          updatedAt: sql`(datetime('now'))`,
        })
        .where(eq(drafts.id, draftId))
        .run();
    } catch (err) {
      logger.error(
        {
          ...logCtx,
          err,
          event: 'draft_persist_failed',
          inputTokens: outcome.value.usage.inputTokens,
          outputTokens: outcome.value.usage.outputTokens,
        },
        'Draft generated but persistence failed',
      );
      yield {
        type: 'error',
        message: err instanceof Error ? err.message : 'Unknown error',
      };
      return;
    }

    logger.info(
      {
        ...logCtx,
        event: 'draft_generated',
        inputTokens: outcome.value.usage.inputTokens,
        outputTokens: outcome.value.usage.outputTokens,
      },
      'Draft generated',
    );
    yield { type: 'done' };
  } catch (err) {
    logger.error({ ...logCtx, err, event: 'draft_generation_failed' }, 'Draft generation failed');
    yield {
      type: 'error',
      message: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
