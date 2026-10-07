# Module 12: Text-to-Speech with Immersion Reading

**Status**: Done
**Last verified against code**: 2026-04 (docs reconciliation)
**Schema tables**: `articles` (ttsParagraph, ttsTimeOffset)
**Unimplemented sections**: none

## Purpose

Add a "Listen" feature to the reader view that reads articles aloud using AI-generated voices, with real-time word-by-word highlighting synced to the audio (immersion reading). Uses Inworld TTS API for high-quality speech with native word timestamp alignment.

## Architecture Overview

```
User clicks "Listen" in reader view
  → Client requests POST /api/tts/[articleId]
  → Server loads article plain text, splits into chunks (≤2000 chars)
  → Server streams each chunk to Inworld TTS API (streaming endpoint)
     - Model: inworld-tts-1.5-max
     - timestampType: WORD
     - timestampTransportStrategy: SYNC
  → Server proxies audio + timestamps back to client via SSE (Server-Sent Events)
  → Client plays audio via Web Audio API
  → Client highlights current word in the DOM using timestamp data
  → Highlighted word auto-scrolls into view
```

## Dependencies

- Inworld TTS API (external service, API key required)
- `src/app/reader/[id]/page.tsx` — Reader view (exists)
- `src/components/reader/article-content.tsx` — Article content renderer (exists)
- `src/db/schema.ts` — Articles table, content_text field (exists)
- `src/lib/errors.ts` — Custom error classes (exists)
- `src/lib/logger.ts` — Structured logging (exists)
- `src/config/index.ts` — App configuration (exists, will extend)

## Setup (Manual — User)

1. Create an Inworld account at https://platform.inworld.ai/
2. Generate an API key
3. Add env vars to `.env` on server:
   ```
   INWORLD_API_KEY=your-api-key-here
   ```
4. If `INWORLD_API_KEY` is not set, the Listen button does not appear (graceful disable)

## API Contract

### `POST /api/tts/[articleId]`

Streams TTS audio and word timestamps for an article. Returns a Server-Sent Events stream.

**Query params:**

- `voiceId` — Inworld voice ID (default: configurable, e.g. "Dennis" for English)
- `speed` — Speaking rate 0.5–1.5 (default: 1.0)
- `startParagraph` — Paragraph index to start from (default: 0)

**Response**: `text/event-stream` (SSE)

**Event types:**

```
event: metadata
data: {"totalParagraphs": 12, "articleTitle": "How to Do Great Work", "language": "en"}

event: audio
data: {"paragraphIndex": 0, "audioContent": "<base64>", "format": "mp3"}

event: timestamps
data: {"paragraphIndex": 0, "words": ["The","quick","brown"], "startTimes": [0, 0.28, 0.55], "endTimes": [0.25, 0.52, 0.88]}

event: paragraph-complete
data: {"paragraphIndex": 0}

event: audio
data: {"paragraphIndex": 1, "audioContent": "<base64>", ...}

event: timestamps
data: {"paragraphIndex": 1, "words": [...], "startTimes": [...], "endTimes": [...]}

event: paragraph-complete
data: {"paragraphIndex": 1}

event: complete
data: {"totalDuration": 145.2}

event: error
data: {"message": "Inworld API error", "paragraphIndex": 3}
```

**Errors:**

- `404` — Article not found
- `422` — Invalid parameters
- `503` — Inworld API unavailable or API key not configured

### `GET /api/tts/voices`

Returns available voices, optionally filtered by language.

**Query params:**

- `language` — Filter by language code (e.g., "en", "fr")

**Response (200):**

```json
{
  "voices": [
    { "voiceId": "Dennis", "name": "Dennis", "language": "en", "gender": "male" },
    { "voiceId": "Marie", "name": "Marie", "language": "fr", "gender": "female" }
  ]
}
```

## Server-Side Processing

### `src/lib/tts.ts`

Core TTS library with no DB dependency.

```typescript
interface TTSChunk {
  paragraphIndex: number;
  audioContent: string; // base64-encoded audio
  words: string[];
  startTimes: number[]; // seconds from start of this paragraph's audio
  endTimes: number[];
}

interface TTSOptions {
  voiceId: string;
  modelId: string; // "inworld-tts-1.5-max"
  speed: number; // 0.5–1.5
  audioEncoding: string; // "MP3"
  sampleRateHertz: number; // 24000
}
```

**Two functions:**

1. `synthesizeParagraph(text: string, options: TTSOptions): AsyncGenerator<TTSChunk>` — Streams a single paragraph through Inworld's streaming endpoint. Yields audio + timestamp chunks as they arrive.

2. `synthesizeArticle(paragraphs: string[], options: TTSOptions): AsyncGenerator<TTSChunk>` — Iterates over paragraphs, calling `synthesizeParagraph` for each. Yields chunks with `paragraphIndex` so the client knows which paragraph the audio belongs to.

### Text Preparation: `src/lib/tts-text.ts`

Prepares article text for TTS synthesis.

```typescript
interface PreparedParagraph {
  index: number;
  text: string; // cleaned text for TTS
  domPath: string; // path to the paragraph element in the article DOM
  wordCount: number;
}
```

**Functions:**

1. `prepareArticleForTTS(contentText: string): PreparedParagraph[]`
   - Split plain text into paragraphs (by `\n\n` or equivalent)
   - Clean each paragraph: strip extra whitespace, normalize Unicode
   - Skip empty paragraphs
   - Enforce Inworld's 2,000 char limit: split long paragraphs at sentence boundaries
   - Return array with indices that map back to DOM paragraphs

2. `mapWordsToDOM(paragraph: PreparedParagraph, words: string[]): WordPosition[]`
   - Maps each word from the TTS response to a character offset in the original paragraph text
   - Used by the client to find the corresponding text node in the DOM

### Inworld API Client: `src/lib/inworld-client.ts`

Low-level HTTP streaming client for Inworld TTS.

```typescript
async function* streamTTS(text: string, options: TTSOptions): AsyncGenerator<InworldChunk> {
  const response = await fetch('https://api.inworld.ai/tts/v1/voice:stream', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${process.env.INWORLD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      voiceId: options.voiceId,
      modelId: options.modelId,
      audioConfig: {
        audioEncoding: options.audioEncoding,
        sampleRateHertz: options.sampleRateHertz,
      },
      speakingRate: options.speed,
      timestampType: 'WORD',
      timestampTransportStrategy: 'SYNC',
      temperature: 1.0,
    }),
  });

  // Parse NDJSON streaming response
  // Each line is a JSON object with { result: { audioContent, timestampInfo, usage } }
  // Yield parsed chunks as they arrive
}
```

## Client-Side Components

### `src/components/reader/tts-player.tsx`

Main TTS player component. Renders the playback controls bar fixed at the bottom of the reader view (above the progress bar if present).

**State:**

- `status`: `'idle' | 'loading' | 'playing' | 'paused'`
- `currentParagraph`: number
- `currentWordIndex`: number
- `speed`: number (0.5–1.5)
- `progress`: number (0–1, overall article progress)

**UI (playback bar):**

```
┌──────────────────────────────────────────────────┐
│  ▶/❚❚    ⏪15s   ⏩15s   0.5x [1x] 1.5x   ✕    │
│  ━━━━━━━━━━●━━━━━━━━━━━━━━━  3:24 / 12:05      │
└──────────────────────────────────────────────────┘
```

- Play/Pause button
- Skip back/forward 15 seconds
- Speed selector: 0.5x, 0.75x, 1x, 1.25x, 1.5x
- Close button (stops playback)
- Progress bar showing position in full article
- Current time / total estimated time

**Keyboard shortcuts:**

- `P` — Play/Pause
- `Shift+P` — Stop
- `←` / `→` — Skip back/forward 15s
- `,` / `.` — Decrease/increase speed

### `src/components/reader/word-highlighter.tsx`

Manages word-by-word highlighting in the article content.

**Approach:**

1. When TTS starts, scan the article content DOM to build a word position map
2. Each `<p>` in the article content gets a `data-paragraph-index` attribute
3. For each paragraph, split text nodes into individual words wrapped in `<span data-word-index="N">`
4. As audio plays, use `requestAnimationFrame` to check current playback time against the timestamp arrays
5. Apply a CSS class (`tts-active-word`) to the current word span
6. Smoothly scroll the highlighted word into view (centered vertically)

**CSS:**

```css
.tts-active-word {
  background-color: var(--highlight-yellow);
  border-radius: 2px;
  transition: background-color 100ms ease;
}
```

**Critical detail — word wrapping must not break the DOM for highlighting:**

- Wrap words lazily: only process paragraphs that are about to be read
- Restore original text nodes when TTS stops (unwrap spans)
- Don't interfere with existing highlight `<mark>` elements

### `src/hooks/useTTSPlayer.ts`

React hook encapsulating TTS playback logic.

```typescript
interface UseTTSPlayerReturn {
  status: 'idle' | 'loading' | 'playing' | 'paused';
  play: (articleId: number, startParagraph?: number) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  skipForward: () => void;
  skipBack: () => void;
  setSpeed: (speed: number) => void;
  currentParagraph: number;
  currentWordIndex: number;
  currentTime: number;
  estimatedTotalTime: number;
  progress: number;
}
```

**Internal logic:**

1. `play()` opens an EventSource to `POST /api/tts/[articleId]`
2. As `audio` events arrive, decode base64 → ArrayBuffer → AudioBuffer via Web Audio API
3. Queue audio buffers for gapless paragraph-to-paragraph playback
4. As `timestamps` events arrive, store word timing arrays per paragraph
5. On each animation frame, check `audioContext.currentTime` against stored timestamps
6. Emit `currentParagraph` and `currentWordIndex` for the highlighter
7. Handle pause/resume via `audioContext.suspend()` / `audioContext.resume()`
8. Skip forward/back: calculate target time, find corresponding paragraph + word, seek

### `src/components/reader/listen-button.tsx`

The "Listen" button shown in the reader view header.

- Only visible when `INWORLD_API_KEY` is configured (check via `GET /api/tts/voices` on mount, or a dedicated config endpoint)
- Headphones icon + "Listen" text
- On click: opens the TTS player bar and starts playback from current scroll position
- Hidden in reader view when `INWORLD_API_KEY` is not set

## Audio Buffering Strategy

To achieve gapless playback between paragraphs:

```
Paragraph 0: [playing audio ▶▶▶▶▶▶▶▶]
Paragraph 1:     [buffering in background...]
Paragraph 2:                                    [not started yet]

When Paragraph 0 finishes:
Paragraph 0: [complete ✓]
Paragraph 1: [playing audio ▶▶▶▶▶▶▶▶] (starts immediately, no gap)
Paragraph 2:     [buffering in background...]
```

**Implementation:**

- Maintain a buffer of 2 paragraphs ahead: current + next
- When `paragraph-complete` event fires, start buffering paragraph N+2
- Use Web Audio API's `AudioBufferSourceNode.start(when)` to schedule the next paragraph at the exact end time of the current one

## Language Detection

Auto-detect article language to select an appropriate default voice:

```typescript
// src/lib/tts-text.ts
export function detectLanguage(text: string): 'en' | 'fr' | string {
  // Simple heuristic: check for common French words/patterns
  // For a more robust solution, use a library like franc-min
  const frenchIndicators = /\b(le|la|les|des|une|est|dans|pour|avec|sur|que|qui|pas|son|ses)\b/gi;
  const matches = text.match(frenchIndicators) || [];
  if (matches.length > text.split(/\s+/).length * 0.1) return 'fr';
  return 'en';
}
```

Map language to default voice via config. Allow user override in the player UI.

## Audio Caching (Optional, Post-MVP)

To avoid re-paying for articles you've already listened to:

- Store generated audio + timestamps in the filesystem: `/data/tts-cache/<articleId>/`
- One file per paragraph: `0.mp3`, `0.json` (timestamps), `1.mp3`, `1.json`, ...
- On subsequent listens, serve from cache instead of calling Inworld API
- Cache invalidation: if article content changes (rare — articles are immutable after save)
- Disk cleanup: cron job deleting cache older than 30 days

**Not in v1** — implement caching only if TTS costs become noticeable.

## Schema Changes

None required. All TTS data is transient (streamed, not stored).

If caching is added later, use filesystem storage, not the database.

## Configuration

New environment variables:

```
INWORLD_API_KEY=your-api-key-here
INWORLD_DEFAULT_VOICE_EN=Dennis
INWORLD_DEFAULT_VOICE_FR=Marie
INWORLD_TTS_MODEL=inworld-tts-1.5-max
```

Add to `src/config/index.ts`:

```typescript
export const ttsConfig = {
  apiKey: process.env.INWORLD_API_KEY || '',
  enabled: !!process.env.INWORLD_API_KEY,
  defaultVoiceEn: process.env.INWORLD_DEFAULT_VOICE_EN || 'Dennis',
  defaultVoiceFr: process.env.INWORLD_DEFAULT_VOICE_FR || 'Marie',
  model: process.env.INWORLD_TTS_MODEL || 'inworld-tts-1.5-max',
  audioEncoding: 'MP3',
  sampleRate: 24000,
};
```

## Files

| File                                            | Action                                                          |
| ----------------------------------------------- | --------------------------------------------------------------- |
| `docs/modules/tts-immersion.md`                 | Create — this spec                                              |
| `src/lib/inworld-client.ts`                     | Create — low-level Inworld streaming client                     |
| `src/lib/tts.ts`                                | Create — paragraph-level TTS orchestration                      |
| `src/lib/tts-text.ts`                           | Create — text preparation, language detection, word-DOM mapping |
| `src/app/api/tts/[articleId]/route.ts`          | Create — SSE endpoint streaming audio + timestamps              |
| `src/app/api/tts/voices/route.ts`               | Create — list available voices                                  |
| `src/components/reader/tts-player.tsx`          | Create — playback bar UI                                        |
| `src/components/reader/word-highlighter.tsx`    | Create — DOM word highlighting                                  |
| `src/components/reader/listen-button.tsx`       | Create — Listen button in reader header                         |
| `src/hooks/useTTSPlayer.ts`                     | Create — playback logic hook                                    |
| `src/lib/validators.ts`                         | Extend — TTS request schemas                                    |
| `src/config/index.ts`                           | Modify — add TTS config                                         |
| `src/app/reader/[id]/page.tsx`                  | Modify — integrate Listen button + TTS player                   |
| `src/app/globals.css`                           | Modify — add `.tts-active-word` style                           |
| `.env.example`                                  | Modify — add INWORLD vars                                       |
| `__tests__/unit/tts-text.test.ts`               | Create — text preparation, chunking, language detection         |
| `__tests__/unit/tts.test.ts`                    | Create — paragraph orchestration, word mapping                  |
| `__tests__/integration/tts.test.ts`             | Create — API route tests (Inworld mocked via MSW)               |
| `__tests__/mocks/fixtures/inworld-responses.ts` | Create — mock Inworld streaming responses                       |

## Edge Cases

1. **Article with no text** — Disable Listen button, show "No text content available"
2. **Very long article (>50 paragraphs)** — Stream paragraph by paragraph, buffer 2 ahead. Don't pre-generate entire article.
3. **Paragraph exceeding 2,000 chars** — Split at sentence boundaries before sending to Inworld. Maintain word index continuity across splits.
4. **Inworld API failure mid-article** — Send `error` SSE event, pause playback, show retry button. Don't crash the reading experience.
5. **User scrolls away during playback** — Show "Return to listening position" button (like Readwise). Clicking it scrolls back and resumes highlighting.
6. **User highlights text during playback** — TTS continues uninterrupted. Highlight creation works normally. The word wrapping spans used by the highlighter must coexist with `<mark>` elements.
7. **Speed change during playback** — Apply to the next paragraph (current paragraph continues at current speed to avoid artifacts).
8. **Mixed language article** — Use the detected primary language voice for the whole article. Don't switch voices mid-article (sounds jarring).
9. **Network interruption** — EventSource auto-reconnects. Server resumes from `startParagraph` parameter.
10. **Browser tab backgrounded** — Web Audio API continues playing in background. Word highlighting pauses (no `requestAnimationFrame` in background tabs) and resumes when tab is focused.
11. **No Inworld API key configured** — Listen button never appears. No error, no broken UI. Feature is invisible.
12. **Concurrent listen requests** — Only one TTS stream per article at a time. Second request cancels the first.

## Security

- **API key**: `INWORLD_API_KEY` stored in `.env`, accessed only server-side via `src/config/index.ts`. Never sent to the client.
- **Input validation**: Article ID validated via Zod. Speed and paragraph index validated and clamped.
- **No user text sent to Inworld**: Only article `content_text` (which was already sanitized at ingestion) is sent to the TTS API.
- **SSE endpoint**: Protected by the same basic auth as all other routes (Caddy layer).
- **Rate limiting**: Client-side debounce on play button prevents accidental multiple streams.

## Inworld API Reference

Claude Code should fetch these docs during implementation for exact API details:

- Streaming endpoint: https://docs.inworld.ai/docs/tts/synthesize-speech-streaming.md
- Timestamp alignment: https://docs.inworld.ai/docs/tts/capabilities/timestamps.md
- API spec: https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/synthesize-speech-stream.md
- Voices list: https://docs.inworld.ai/api-reference/ttsAPI/texttospeech/list-voices.md
- Best practices: https://docs.inworld.ai/docs/tts/best-practices/generating-speech.md
- Latency optimization: https://docs.inworld.ai/docs/tts/best-practices/latency.md
- LLM documentation index: https://platform.inworld.ai/llms.txt
