import { DEFAULT_DRAFT_MODEL, type DraftModelId } from '@/lib/models';
import type { TemplateId } from '@/types';

export const ANGLE_MAX = 500;
const ANGLE_WARNING_THRESHOLD = 450;

export interface PickerState {
  step: 1 | 2;
  templateId: TemplateId | null;
  model: DraftModelId;
  checkedHighlights: Set<number>;
  checkedResearch: Set<number>;
  angle: string;
  submitting: boolean;
  error: string | null;
}

export type PickerAction =
  | { type: 'select_template'; templateId: TemplateId }
  | { type: 'back' }
  | { type: 'toggle_highlight'; id: number }
  | { type: 'toggle_research'; id: number }
  | { type: 'set_angle'; value: string }
  | { type: 'set_model'; model: DraftModelId }
  | { type: 'submit_start' }
  | { type: 'submit_error'; message: string }
  | { type: 'submit_success' }
  | {
      type: 'reset';
      highlights: readonly { id: number }[];
      research: readonly { id: number }[];
    };

export interface SubmitPayload {
  thesisId: number;
  templateId: TemplateId;
  model: DraftModelId;
  angle: string | undefined;
  includedHighlightIds: number[];
  includedResearchIds: number[];
}

/** Build the initial picker state with every highlight and research entry checked. */
export function initPickerState(
  highlights: readonly { id: number }[],
  research: readonly { id: number }[],
): PickerState {
  return {
    step: 1,
    templateId: null,
    model: DEFAULT_DRAFT_MODEL,
    checkedHighlights: new Set(highlights.map((h) => h.id)),
    checkedResearch: new Set(research.map((r) => r.id)),
    angle: '',
    submitting: false,
    error: null,
  };
}

function toggle(set: Set<number>, id: number): Set<number> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

export function reducer(state: PickerState, action: PickerAction): PickerState {
  switch (action.type) {
    case 'select_template':
      return { ...state, templateId: action.templateId, step: 2 };
    case 'back':
      return { ...state, step: 1 };
    case 'toggle_highlight':
      return { ...state, checkedHighlights: toggle(state.checkedHighlights, action.id) };
    case 'toggle_research':
      return { ...state, checkedResearch: toggle(state.checkedResearch, action.id) };
    case 'set_angle':
      return { ...state, angle: action.value.slice(0, ANGLE_MAX) };
    case 'set_model':
      return { ...state, model: action.model };
    case 'submit_start':
      return { ...state, submitting: true, error: null };
    case 'submit_error':
      return { ...state, submitting: false, error: action.message };
    case 'submit_success':
      return { ...state, submitting: false, error: null };
    case 'reset':
      return initPickerState(action.highlights, action.research);
  }
}

export function isAngleWarning(angle: string): boolean {
  return angle.length >= ANGLE_WARNING_THRESHOLD;
}

/** Build the POST /api/drafts payload. Caller must ensure `templateId` is set. */
export function buildSubmitPayload(state: PickerState, thesisId: number): SubmitPayload {
  if (state.templateId === null) {
    throw new Error('Cannot build submit payload without a selected template');
  }
  const trimmed = state.angle.trim();
  return {
    thesisId,
    templateId: state.templateId,
    model: state.model,
    angle: trimmed === '' ? undefined : trimmed,
    includedHighlightIds: [...state.checkedHighlights].sort((a, b) => a - b),
    includedResearchIds: [...state.checkedResearch].sort((a, b) => a - b),
  };
}
