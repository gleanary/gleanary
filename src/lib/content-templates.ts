import type { ContentTemplate, TemplateId } from '@/types';

export const TEMPLATES: Record<TemplateId, ContentTemplate> = {
  blog: {
    id: 'blog',
    name: 'Blog Post',
    description:
      'A structured long-form essay with sections, evidence buildup, and a clear argument arc.',
    targetLength: { min: 800, max: 2000 },
    channelHint: 'blog',
    instructions: `Write a long-form blog post. Structure: a hook in the opening paragraph that surfaces the tension or surprise behind the claim, then a single thesis sentence no later than the third paragraph. Follow with 3–5 body sections, each introduced with an H2 heading (##), developing one dimension of the argument — evidence, implication, counterpoint, or mechanism. Close with a short final section (no heading) that reframes the opening hook in light of what was argued, ending on a consequence or open question rather than a summary restatement.

Formatting rules: Use H2 headings only (no H1, no H3). Paragraphs should be 3–5 sentences and stand alone — no one-liners as filler. Code or data, when referenced, should be inline or in a fenced block; avoid raw URLs in body text. No bullet lists in the body; prose only. A single optional pull-quote or callout block is acceptable if the material warrants it.

Length target: 800–2 000 words. Under 800 words the argument will feel underdeveloped. Over 2 000 words reread for redundancy before submitting.

Tone register: analytical and direct. The voice is an expert writing for a peer, not a teacher writing for a student. Assume the reader knows the domain; do not over-explain standard concepts. Where you introduce a non-obvious claim, show the reasoning — don't assert.`,
  },

  linkedin: {
    id: 'linkedin',
    name: 'LinkedIn Post',
    description:
      'A short punchy post optimised for LinkedIn: single insight, short paragraphs, no headers.',
    targetLength: { min: 150, max: 400 },
    channelHint: 'linkedin, short-form, social',
    instructions: `Write a LinkedIn post. Open with a single provocation, concrete observation, or counterintuitive claim — the first line must work as a standalone hook because it is what the reader sees before "see more". Do not start with "I" or with a question.

Structure: hook line → 2–4 short paragraphs developing the single core insight → close with either a consequence the reader can act on or a genuinely open question (not a call-to-engagement bait). One idea only — resist the urge to list multiple points.

Formatting rules: paragraphs are 1–3 sentences, separated by blank lines. No H2 headings, no bullet lists, no bold or italic markup. No hashtags inline (they may appear at the very end as a line of their own, 2–3 max). No "Like and share if you agree" closers.

Length target: 150–400 words. Shorter is better. If you are over 300 words, cut the least essential paragraph.

Tone register: confident and direct, slightly more conversational than a blog post. First person is natural here. Write like a practitioner sharing an insight, not a brand publishing content.`,
  },

  youtube: {
    id: 'youtube',
    name: 'YouTube Script',
    description:
      'A spoken-word script with a cold open, natural rhythm, and stage direction cues in brackets.',
    targetLength: { min: 400, max: 1200 },
    channelHint: 'youtube, script, spoken',
    instructions: `Write a YouTube video script intended for direct delivery to camera. The script must read aloud naturally — short sentences, contractions, natural pauses.

Structure: cold open (0–30 seconds of spoken time) that drops the viewer directly into the tension or the payoff without introduction or channel preamble. Then a brief "what this video is about" beat (1–2 sentences), followed by the body which develops the argument in spoken-word paragraphs. Close with a reframe of the cold open and a single call to action or reflection prompt.

Stage direction conventions: use bracketed cues sparingly for non-verbal beats — [pause], [to camera], [cut to screen recording], [beat]. Do not over-direct; one cue per 100 words maximum.

Formatting rules: no H2 headings — use prose transitions to signal section shifts ("Here's where it gets interesting", "But there's a catch"). No bullet lists. Short paragraphs (2–4 sentences). Write contractions as spoken (don't, you're, it's). Avoid parenthetical asides — if it belongs in the script, write it out loud.

Length target: 400–1 200 words, equivalent to roughly 3–8 minutes at a natural speaking pace (≈150 wpm). Under 400 words is a Short, not a full video. Over 1 200 words consider splitting into two videos.

Tone register: direct and energetic, but not performatively enthusiastic. The host is thinking out loud with the viewer, not presenting to them. First person throughout.`,
  },
};

/**
 * Returns the ContentTemplate for the given id.
 * @param id - The template identifier
 * @returns The ContentTemplate
 * @throws Error if the id is not a known template
 */
export function getTemplate(id: TemplateId): ContentTemplate {
  const template = TEMPLATES[id];
  if (!template) throw new Error(`Unknown template id: ${id}`);
  return template;
}
