import { expect } from 'vitest';
import { ANTHROPIC_MODELS, DRAFT_MODEL_IDS } from '@/lib/models';

/** Claude model id retired 2026-06-15; Anthropic returns 404 not_found_error for it. */
export const RETIRED_MODEL_ID = 'claude-sonnet-4-20250514';

/** API ids of active (selectable) registry models; historical entries have no features. */
export const ACTIVE_MODEL_IDS = new Set([...ANTHROPIC_MODELS.map((m) => m.id), ...DRAFT_MODEL_IDS]);

/**
 * Asserts an outgoing request's model is an active registry entry (not the retired id).
 * @param model - The `model` field captured from the request body.
 */
export function expectActiveModel(model: unknown): void {
  expect(model).not.toBe(RETIRED_MODEL_ID);
  expect(ACTIVE_MODEL_IDS.has(model as string), `model ${String(model)}`).toBe(true);
}
