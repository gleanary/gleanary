import { describe, it, expect } from 'vitest';
import {
  truncateContent,
  parseTagsResponse,
  SUMMARIZE_PROMPT,
  AUTO_TAG_PROMPT,
  EXPLAIN_PROMPT,
  IMPORTANCE_PROMPT,
  MAX_CONTENT_LENGTH,
} from '@/lib/ai';

describe('AI utilities', () => {
  describe('truncateContent', () => {
    it('returns content unchanged when under limit', () => {
      const content = 'Short content';
      expect(truncateContent(content)).toBe(content);
    });

    it('truncates content exceeding MAX_CONTENT_LENGTH', () => {
      const content = 'a'.repeat(MAX_CONTENT_LENGTH + 1000);
      const result = truncateContent(content);
      expect(result.length).toBeLessThanOrEqual(MAX_CONTENT_LENGTH);
    });

    it('appends truncation notice when truncated', () => {
      const content = 'a'.repeat(MAX_CONTENT_LENGTH + 1000);
      const result = truncateContent(content);
      expect(result).toContain('[Content truncated]');
    });

    it('handles empty string', () => {
      expect(truncateContent('')).toBe('');
    });
  });

  describe('parseTagsResponse', () => {
    it('parses a valid JSON array of strings', () => {
      const response = '["typescript", "testing", "react"]';
      expect(parseTagsResponse(response)).toEqual(['typescript', 'testing', 'react']);
    });

    it('extracts JSON array from surrounding text', () => {
      const response = 'Here are the tags: ["typescript", "testing"] based on the content.';
      expect(parseTagsResponse(response)).toEqual(['typescript', 'testing']);
    });

    it('deduplicates tag names (case-insensitive)', () => {
      const response = '["TypeScript", "typescript", "React"]';
      expect(parseTagsResponse(response)).toEqual(['typescript', 'react']);
    });

    it('filters out non-string entries', () => {
      const response = '["valid", 123, null, "also-valid"]';
      expect(parseTagsResponse(response)).toEqual(['valid', 'also-valid']);
    });

    it('trims whitespace from tag names', () => {
      const response = '["  typescript  ", " react "]';
      expect(parseTagsResponse(response)).toEqual(['typescript', 'react']);
    });

    it('filters out empty strings', () => {
      const response = '["typescript", "", "  ", "react"]';
      expect(parseTagsResponse(response)).toEqual(['typescript', 'react']);
    });

    it('returns empty array for unparseable response', () => {
      expect(parseTagsResponse('not json at all')).toEqual([]);
    });

    it('returns empty array for empty response', () => {
      expect(parseTagsResponse('')).toEqual([]);
    });
  });

  describe('system prompts', () => {
    it('exports all system prompts as non-empty strings', () => {
      expect(SUMMARIZE_PROMPT).toBeTruthy();
      expect(AUTO_TAG_PROMPT).toBeTruthy();
      expect(EXPLAIN_PROMPT).toBeTruthy();
      expect(IMPORTANCE_PROMPT).toBeTruthy();
    });
  });
});
