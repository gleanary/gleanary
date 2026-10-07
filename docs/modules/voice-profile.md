# Module 15: Voice Profile

**Status**: Done
**Last verified against code**: 2026-04 (docs session)
**Schema tables**: `voice_profile`, `voice_samples`
**Unimplemented sections**: none
**Dependencies**: Module 7 (AI Features — Claude API client), Module 1 (Data Layer — settings system)

---

## Purpose

Define and maintain a structured writing voice profile that drives all content generation across channels. The voice profile captures _how you write_ — sentence rhythm, vocabulary, argument construction, rhetorical devices, anti-patterns — as a reusable identity layer that is cleanly separated from channel-specific format constraints (handled by the future Templates module).

The module provides two things: (1) AI-powered extraction of a structured voice profile from writing samples, and (2) storage and management of both the profile and its source samples for use at generation time.

## Why This Matters

The gap between "generic AI output" and "sounds like me" is where most AI-assisted content creation fails. Research across 30+ tools confirms that:

- Tools using actual writing samples dramatically outperform description-based approaches
- A structured profile with evidence-backed dimensions produces better output than free-text descriptions
- Sentence rhythm _variance_ (not average length) is the primary voice differentiator
- Including 1–2 original samples alongside the profile at generation time significantly improves fidelity
- Voice drift in long-form content is a technical reality requiring section-level re-injection strategies

This module captures voice identity once, stores it durably, and makes it available as a system prompt component for all content generation. The companion Templates module (future) handles channel-specific structure, format constraints, and sample selection at generation time.

## Design Decisions

### Voice applies to content generation only

Summaries, thesis suggestions, chat responses, and AI explanations serve analytical purposes — they help the user think. Voice kicks in only when the user is _publishing_: drafting a blog post, LinkedIn post, YouTube script, or book chapter. The boundary is: **am I thinking, or am I publishing?**

### Single profile, not per-channel profiles

What changes between LinkedIn and a blog post is the template, not the voice. One well-defined profile with rich samples gives the model a much stronger signal than multiple thin profiles. Channel-specific differences (length, formatting, tone register) are handled structurally by templates. The voice profile must contain **zero formatting instructions** — no mention of post length, section headers, emoji usage, or any format-dependent pattern.

### Generate → review → edit manually

No iterative AI refinement loop. The extraction step produces a draft profile from samples. The user reviews it, edits it by hand, and saves. Re-extraction overwrites the profile (with confirmation). This keeps the module simple and the user in full control.

### English only

The profile is monolingual (English). The user handles French translation manually, since LLMs are not reliable at adapting tone, nuance, and phrasing across languages.

### Samples are pasted or uploaded, never imported from the article library

Most articles in the DB are things the user _read_, not things they _wrote_. To keep things simple, samples are always provided explicitly via paste or file upload.

### Sample selection delegated to the Templates module

At generation time, the Templates module selects which samples (if any) to include alongside the profile, based on channel affinity via the `channel_hint` field on samples. This enables future refinement based on published content performance without touching the Voice module.

---

## Data Model

### New Tables

#### `voice_profile`

Single-row table (single user, single profile).

```
id                INTEGER PRIMARY KEY AUTOINCREMENT
user_id           INTEGER NOT NULL DEFAULT 1
profile           TEXT NOT NULL DEFAULT ''    -- structured markdown (800–1,500 words)
extracted_at      TEXT                        -- when AI last generated the profile
sample_count      INTEGER DEFAULT 0          -- how many samples were used in extraction
manual_edits_at   TEXT                        -- when user last hand-edited the profile
created_at        TEXT NOT NULL DEFAULT (datetime('now'))
updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
```

The `profile` field stores a structured markdown document with evidence-backed dimensions. This is what gets injected into generation prompts as system prompt content.

#### `voice_samples`

```
id                INTEGER PRIMARY KEY AUTOINCREMENT
profile_id        INTEGER NOT NULL REFERENCES voice_profile(id) ON DELETE CASCADE
title             TEXT NOT NULL              -- user-provided label, e.g. "Blog: AI pair programming"
content           TEXT NOT NULL              -- the writing sample text
word_count        INTEGER NOT NULL DEFAULT 0
channel_hint      TEXT                       -- comma-separated tags, e.g. "blog, long-form, technical"
created_at        TEXT NOT NULL DEFAULT (datetime('now'))
```

### No schema changes to existing tables

The voice module is self-contained. Content generation routes (future Templates module) will read from these tables at generation time.

---

## Voice Profile Structure

The extraction prompt produces a structured markdown document with these dimensions. Each dimension includes 1–3 sentences of description plus quoted evidence from the samples.

```markdown
## Rhythm & Sentence Structure

[Description of sentence length distribution, variation patterns, use of fragments,
paragraph length tendencies. Key metric: variance in sentence length, not average.]

> Evidence: "quoted phrase demonstrating the pattern"

## Vocabulary & Register

[Technical density, formality level, jargon comfort, signature phrases,
words/phrases the author gravitates toward.]

> Evidence: "quoted phrase"

## Argument Construction

[How the author builds a case: claim-first then evidence? Narrative buildup?
Socratic questioning? How evidence is marshaled.]

> Evidence: "quoted phrase"

## Opening Patterns

[How the author hooks: provocative claim, question, anecdote, context-setting,
contrast, data point. Frequency of each.]

> Evidence: "quoted phrase"

## Closing Patterns

[How the author lands: call to action, reframe, open question, summary,
callback to opening. Frequency of each.]

> Evidence: "quoted phrase"

## Rhetorical Devices

[What the author reaches for: analogies, rhetorical questions, numbered lists,
anecdotes, data citations, humor, irony. Note frequency — use at natural rate,
do not amplify.]

> Evidence: "quoted phrase"

## Tone & Confidence

[Confidence level, humor frequency and style, formality shifts,
emotional register, directness vs. hedging.]

> Evidence: "quoted phrase"

## Anti-Patterns

[Things the author explicitly avoids or never does: hedging language, passive voice,
corporate jargon, emoji, clichés, specific phrases. These are negative constraints
that should be enforced strictly.]

> Evidence: absence noted across N samples
```

Target length: **800–1,500 words**. Dense enough to meaningfully steer generation, short enough to fit in a system prompt alongside template instructions and content context.

---

## API Contract

### Voice Profile

#### `GET /api/voice/profile`

Returns the current voice profile and metadata.

```typescript
// Response 200
{
  profile: {
    id: number;
    profile: string; // markdown text
    extractedAt: string | null;
    sampleCount: number;
    manualEditsAt: string | null;
    createdAt: string;
    updatedAt: string;
  }
  sampleCount: number; // current number of samples in DB
}

// Response 200 (no profile exists yet)
{
  profile: null;
  sampleCount: 0;
}
```

#### `PUT /api/voice/profile`

Create or update the voice profile text (manual edit).

```typescript
// Request
{
  profile: string;            // markdown text, min 100 chars, max 10000 chars
}

// Response 200
{
  profile: { ...updated profile object };
}
```

Sets `manual_edits_at` to current timestamp. If no profile row exists, creates one.

#### `POST /api/voice/profile/extract`

Generate a structured voice profile from current samples using Claude.

```typescript
// Request
{
  force?: boolean;            // default false — if true, overwrite even if manual edits exist
}

// Response 200
{
  profile: { ...updated profile object };
  tokensUsed: number;
}

// Response 409 (manual edits exist and force=false)
{
  error: "Profile has manual edits. Set force=true to overwrite.";
  manualEditsAt: string;
}

// Response 422 (not enough samples)
{
  error: "At least 3 writing samples are required for extraction.";
  currentCount: number;
}
```

Requires minimum 3 samples. Uses Claude (Sonnet) for extraction — this is a one-time operation where quality matters more than speed/cost.

### Voice Samples

#### `GET /api/voice/samples`

List all writing samples.

```typescript
// Response 200
{
  samples: Array<{
    id: number;
    title: string;
    content: string;
    wordCount: number;
    channelHint: string | null;
    createdAt: string;
  }>;
}
```

#### `POST /api/voice/samples`

Add a writing sample.

```typescript
// Request
{
  title: string;              // 1–200 chars
  content: string;            // 100–50000 chars (writing sample text)
  channelHint?: string;       // optional, e.g. "blog, long-form"
}

// Response 201
{
  sample: { ...created sample object };
}
```

Word count computed server-side from content.

#### `PATCH /api/voice/samples/[id]`

Update sample metadata (title, channel hint). Content is immutable after creation — if the sample text needs changing, delete and re-add.

```typescript
// Request (at least one field)
{
  title?: string;
  channelHint?: string;
}

// Response 200
{
  sample: { ...updated sample object };
}
```

#### `DELETE /api/voice/samples/[id]`

Remove a writing sample.

```typescript
// Response 200
{
  deleted: true;
}
```

---

## Extraction Prompt

The extraction prompt is the core of the module. It runs once (or on re-extraction) and produces the structured profile.

```
You are a writing style analyst. Analyze the following writing samples from a single
author and produce a structured voice profile.

IMPORTANT RULES:
- Extract patterns at their NATURAL FREQUENCY. If analogies appear in 1 of every
  3 paragraphs, that's the target — do not amplify distinctive features.
- Include specific quoted evidence from the samples for every dimension.
- The profile must be CHANNEL-AGNOSTIC. Do not mention post length, section headers,
  emoji, platform conventions, or any format-dependent pattern. Describe HOW the author
  thinks and expresses, not how they format.
- Focus on what makes this author's writing distinguishable from generic AI output.
- Note anti-patterns (things the author never does) — these are as important as
  positive patterns.

Produce the profile using EXACTLY this structure:

## Rhythm & Sentence Structure
[Sentence length distribution and variation, fragments, paragraph tendencies]
> Evidence: "quoted phrase"

## Vocabulary & Register
[Technical density, formality, signature phrases, preferred/avoided words]
> Evidence: "quoted phrase"

## Argument Construction
[How cases are built: claim-first, narrative, Socratic, evidence marshaling]
> Evidence: "quoted phrase"

## Opening Patterns
[Hook strategies with frequency]
> Evidence: "quoted phrase"

## Closing Patterns
[Landing strategies with frequency]
> Evidence: "quoted phrase"

## Rhetorical Devices
[Devices used with natural frequency noted]
> Evidence: "quoted phrase"

## Tone & Confidence
[Confidence level, humor, formality shifts, emotional register]
> Evidence: "quoted phrase"

## Anti-Patterns
[Things the author avoids — enforce strictly]
> Evidence: absence noted

TARGET LENGTH: 800–1,500 words.

---

WRITING SAMPLES:

{samples, concatenated with "--- Sample N: {title} ---" separators}
```

Uses Claude Sonnet for quality. Estimated cost: ~10K input tokens (samples) + ~1K output tokens per extraction.

---

## Validation Schemas

```typescript
// Profile update
const updateVoiceProfileSchema = z.object({
  profile: z.string().min(100).max(10000),
});

// Profile extraction
const extractVoiceProfileSchema = z.object({
  force: z.boolean().optional().default(false),
});

// Create sample
const createVoiceSampleSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(100).max(50000),
  channelHint: z.string().max(200).optional(),
});

// Update sample
const updateVoiceSampleSchema = z
  .object({
    title: z.string().min(1).max(200).optional(),
    channelHint: z.string().max(200).nullable().optional(),
  })
  .refine((data) => Object.values(data).some((v) => v !== undefined));
```

---

## UI Design

### Settings Page Restructure

The current `/settings` page gains a left sidebar navigation (similar to Readwise Reader's Preferences pattern):

- **General** — appearance mode, daily review batch size (existing settings)
- **Integrations** — API keys, IMAP config, Readwise (existing settings sections)
- **Voice** — voice profile and samples management

The sidebar is a simple vertical nav list. Each section renders its own content area on the right.

### Voice Section

Two subsections within the Voice settings panel:

**Profile subsection:**

- If no profile exists: empty state with "Add at least 3 writing samples, then generate your voice profile" message
- If profile exists: rendered markdown in a readable format with an "Edit" button that switches to a textarea
- "Regenerate from samples" button (triggers extraction, with confirmation if manual edits exist)
- Metadata line: "Generated from N samples on {date}" and/or "Last edited {date}"

**Samples subsection:**

- List of samples as collapsible cards showing title, word count, channel hint tags, and creation date
- Expand to preview the full sample text
- "Add sample" button → modal/form with title, content (textarea or file upload), and optional channel hint tags
- Each sample has edit (title/tags only) and delete actions
- File upload accepts `.txt` and `.md` files, extracts text content

### Workflow

1. User adds 3+ writing samples (paste or upload)
2. User clicks "Generate voice profile"
3. AI analyzes samples, produces structured profile
4. Profile displayed in rendered markdown
5. User reviews, clicks "Edit" to refine by hand
6. Profile saved — ready for use by Templates module

---

## Edge Cases

1. **Fewer than 3 samples** — extraction button disabled with helper text explaining the minimum. Profile can still be written manually (PUT endpoint has no sample count requirement).
2. **Very short samples** — minimum 100 chars per sample enforced. Extraction quality degrades with short samples; the extraction prompt handles this gracefully.
3. **Very long samples** — maximum 50,000 chars per sample. At extraction time, if total sample content exceeds ~80K chars, truncate the longest samples with a notice.
4. **Re-extraction with manual edits** — requires `force: true`. UI shows confirmation: "This will overwrite your manual edits. Continue?"
5. **No Anthropic API key** — "Generate" button hidden. Manual profile creation works normally via PUT.
6. **Profile too long for system prompt** — the 1,500-word cap (~2K tokens) keeps the profile within budget. At generation time, profile + template instructions + content context must fit within the model's context window. The Templates module is responsible for this budget management.
7. **Sample deletion after extraction** — profile is not automatically invalidated. Metadata shows "Generated from N samples" which may differ from current sample count. User can re-extract if desired.
8. **Empty channel_hint** — valid. The Templates module falls back to random or most recent sample selection when no channel affinity match exists.
9. **Single profile row** — the table enforces single-user semantics. PUT upserts (creates if missing, updates if exists).

---

## Security

- **Input validation**: Zod schemas on all inputs
- **No new secrets**: uses existing Anthropic API key
- **No HTML rendering**: profile displayed as rendered markdown using the same safe markdown pipeline as chat messages
- **Sample content**: stored as plain text, never rendered as HTML
- **XSS**: no `dangerouslySetInnerHTML` anywhere in the voice UI

---

## Test Plan

### Unit Tests

1. **Word count computation** — verify accurate word counting for sample content
2. **Extraction prompt assembly** — verify samples are concatenated correctly with separators, truncation at length limit
3. **Profile validation** — verify min/max length enforcement
4. **Sample validation** — verify title, content, channelHint constraints

### Integration Tests

1. **GET /api/voice/profile** — returns null when no profile exists
2. **PUT /api/voice/profile** — creates profile, updates profile, validates min length
3. **POST /api/voice/profile/extract** — with sufficient samples (mock Claude), with < 3 samples (422), with manual edits and force=false (409), with force=true (overwrites)
4. **GET /api/voice/samples** — empty list, populated list
5. **POST /api/voice/samples** — create with all fields, create with minimal fields, word count computed correctly, validate content min/max
6. **PATCH /api/voice/samples/[id]** — update title, update channelHint, 404 for nonexistent
7. **DELETE /api/voice/samples/[id]** — delete existing, 404 for nonexistent
8. **Profile-sample relationship** — deleting profile cascades to samples (unlikely but tested)

---

## Files

| File                                               | Action                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/modules/voice-profile.md`                    | Create — this spec                                                        |
| `src/db/schema.ts`                                 | Modify — add `voice_profile` and `voice_samples` tables                   |
| `src/types/index.ts`                               | Extend — VoiceProfile, VoiceSample, NewVoiceProfile, NewVoiceSample types |
| `src/lib/validators.ts`                            | Extend — voice Zod schemas                                                |
| `src/lib/voice-extraction.ts`                      | Create — extraction prompt assembly + Claude call                         |
| `src/app/api/voice/profile/route.ts`               | Create — GET + PUT                                                        |
| `src/app/api/voice/profile/extract/route.ts`       | Create — POST                                                             |
| `src/app/api/voice/samples/route.ts`               | Create — GET + POST                                                       |
| `src/app/api/voice/samples/[id]/route.ts`          | Create — PATCH + DELETE                                                   |
| `src/app/settings/page.tsx`                        | Modify — add left sidebar navigation                                      |
| `src/components/settings/settings-sidebar.tsx`     | Create — sidebar nav component                                            |
| `src/components/settings/voice-section.tsx`        | Create — profile + samples management UI                                  |
| `src/components/settings/voice-profile-editor.tsx` | Create — markdown display + edit toggle                                   |
| `src/components/settings/voice-sample-card.tsx`    | Create — collapsible sample card                                          |
| `src/components/settings/voice-sample-form.tsx`    | Create — add/edit sample modal                                            |
| `CHANGELOG.md`                                     | Update                                                                    |
| `drizzle/`                                         | New migration                                                             |
| `__tests__/unit/voice-extraction.test.ts`          | Create                                                                    |
| `__tests__/integration/voice.test.ts`              | Create — mock Claude extraction via `setupHandlers(...)`                  |
