import Link from 'next/link';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isAngleWarning, ANGLE_MAX } from '@/lib/draft-picker-state';
import type { PickerAction, PickerState } from '@/lib/draft-picker-state';
import { DRAFT_MODELS } from '@/lib/models';
import type {
  Thesis,
  ThesisHighlightRole,
  ThesisLinkedHighlight,
  ThesisResearchSummary,
  VoiceProfile,
} from '@/types';

const ROLE_LABELS: Record<ThesisHighlightRole, string> = {
  supporting: 'Supporting',
  opposing: 'Opposing',
  context: 'Context',
};
const ROLE_ORDER: ThesisHighlightRole[] = ['supporting', 'opposing', 'context'];

interface ContextSelectionStepProps {
  state: PickerState;
  dispatch: (action: PickerAction) => void;
  thesis: Thesis;
  highlights: ThesisLinkedHighlight[];
  research: ThesisResearchSummary[];
  voiceProfile: VoiceProfile | null;
  voiceProfileLoaded: boolean;
}

export function ContextSelectionStep({
  state,
  dispatch,
  thesis,
  highlights,
  research,
  voiceProfile,
  voiceProfileLoaded,
}: ContextSelectionStepProps) {
  const hasNoSupportingContent = highlights.length === 0 && research.length === 0;
  const angleCounterClass = isAngleWarning(state.angle)
    ? 'text-destructive'
    : 'text-muted-foreground';

  return (
    <div className="space-y-5">
      <div>
        <h4 className="text-muted-foreground mb-1 text-xs font-semibold tracking-wide uppercase">
          Claim
        </h4>
        <p className="text-foreground text-sm leading-relaxed">
          {thesis.claim?.trim() ? thesis.claim : <span className="italic">No claim set.</span>}
        </p>
      </div>

      {voiceProfileLoaded && voiceProfile === null && (
        <div
          className="border-border bg-muted/40 rounded-md border p-3 text-xs"
          data-testid="voice-profile-warning"
        >
          <p className="text-foreground">
            No voice profile. The draft will follow the template but won&apos;t match your voice.{' '}
            <Link
              href="/settings#voice"
              className="text-primary hover:underline"
              data-testid="voice-profile-settings-link"
            >
              Set up voice →
            </Link>
          </p>
        </div>
      )}

      {hasNoSupportingContent && (
        <p className="text-muted-foreground text-xs" data-testid="low-content-note">
          This thesis has limited supporting content. Add highlights for a stronger draft.
        </p>
      )}

      {highlights.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-foreground text-sm font-medium">Highlights</h4>
          {ROLE_ORDER.map((role) => {
            const group = highlights.filter((h) => h.role === role);
            if (group.length === 0) return null;
            return (
              <div key={role} className="space-y-1.5">
                <h5 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
                  {ROLE_LABELS[role]}
                </h5>
                <ul className="space-y-1.5">
                  {group.map((h) => (
                    <li key={h.id} className="flex items-start gap-2">
                      <Checkbox
                        id={`picker-highlight-${h.id}`}
                        checked={state.checkedHighlights.has(h.id)}
                        onCheckedChange={() => dispatch({ type: 'toggle_highlight', id: h.id })}
                        className="mt-0.5"
                        data-testid={`picker-highlight-${h.id}`}
                      />
                      <label
                        htmlFor={`picker-highlight-${h.id}`}
                        className="text-foreground cursor-pointer text-sm leading-snug"
                      >
                        <span className="line-clamp-2">{h.text}</span>
                        <span className="text-muted-foreground mt-0.5 block text-xs">
                          {h.article.title}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {research.length > 0 && (
        <div className="space-y-2">
          <h4 className="text-foreground text-sm font-medium">Research</h4>
          <ul className="space-y-1.5">
            {research.map((r) => (
              <li key={r.id} className="flex items-start gap-2">
                <Checkbox
                  id={`picker-research-${r.id}`}
                  checked={state.checkedResearch.has(r.id)}
                  onCheckedChange={() => dispatch({ type: 'toggle_research', id: r.id })}
                  className="mt-0.5"
                  data-testid={`picker-research-${r.id}`}
                />
                <label
                  htmlFor={`picker-research-${r.id}`}
                  className="text-foreground cursor-pointer text-sm leading-snug"
                >
                  {r.title}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <label className="text-foreground mb-1 block text-sm font-medium">Model</label>
        <Select
          value={state.model}
          onValueChange={(v) => dispatch({ type: 'set_model', model: v as PickerState['model'] })}
          disabled={state.submitting}
        >
          <SelectTrigger className="w-full" data-testid="picker-model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DRAFT_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id}>
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <label htmlFor="picker-angle" className="text-foreground mb-1 block text-sm font-medium">
          Angle <span className="text-muted-foreground font-normal">(optional)</span>
        </label>
        <textarea
          id="picker-angle"
          value={state.angle}
          onChange={(e) => dispatch({ type: 'set_angle', value: e.target.value })}
          placeholder="Lead with the contrarian take, aim at executives, etc."
          rows={3}
          maxLength={ANGLE_MAX}
          disabled={state.submitting}
          className="border-input bg-background text-foreground placeholder:text-muted-foreground focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
          data-testid="picker-angle"
        />
        <p className={`mt-1 text-right text-xs ${angleCounterClass}`}>
          {state.angle.length}/{ANGLE_MAX}
        </p>
      </div>

      {state.error && (
        <p className="text-destructive text-sm" data-testid="picker-error">
          {state.error}
        </p>
      )}
    </div>
  );
}
