import { describe, it, expect } from 'vitest';
import { TEMPLATES, getTemplate } from '@/lib/content-templates';
import { TEMPLATE_IDS } from '@/types';
import type { TemplateId } from '@/types';

describe('TEMPLATES registry', () => {
  it('contains all three built-in templates', () => {
    for (const id of TEMPLATE_IDS) {
      expect(TEMPLATES[id]).toBeDefined();
    }
  });

  it.each(TEMPLATE_IDS)('%s template has required fields', (id) => {
    const t = TEMPLATES[id];
    expect(t.id).toBe(id);
    expect(t.name.length).toBeGreaterThan(0);
    expect(t.description.length).toBeGreaterThan(0);
    expect(t.channelHint.length).toBeGreaterThan(0);
    expect(t.instructions.length).toBeGreaterThan(0);
  });

  it.each(TEMPLATE_IDS)('%s targetLength has min < max', (id) => {
    const { min, max } = TEMPLATES[id].targetLength;
    expect(min).toBeGreaterThan(0);
    expect(max).toBeGreaterThan(min);
  });

  it('blog channelHint matches "blog"', () => {
    expect(TEMPLATES.blog.channelHint).toContain('blog');
  });

  it('linkedin channelHint contains expected tokens', () => {
    expect(TEMPLATES.linkedin.channelHint).toContain('linkedin');
  });

  it('youtube channelHint contains expected tokens', () => {
    expect(TEMPLATES.youtube.channelHint).toContain('youtube');
  });
});

describe('getTemplate', () => {
  it('returns blog template for "blog"', () => {
    const t = getTemplate('blog');
    expect(t.id).toBe('blog');
  });

  it('returns linkedin template for "linkedin"', () => {
    const t = getTemplate('linkedin');
    expect(t.id).toBe('linkedin');
  });

  it('returns youtube template for "youtube"', () => {
    const t = getTemplate('youtube');
    expect(t.id).toBe('youtube');
  });

  it('throws for an unknown template id', () => {
    expect(() => getTemplate('nonexistent' as TemplateId)).toThrow(
      'Unknown template id: nonexistent',
    );
  });
});
