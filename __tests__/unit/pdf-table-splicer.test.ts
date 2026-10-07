import { describe, it, expect } from 'vitest';
import { appendPageTables } from '@/lib/pdf-table-splicer';

describe('appendPageTables', () => {
  describe('positional marker replacement', () => {
    it('replaces a link-style marker using Mistral id format (tbl-N.html)', () => {
      const md = '## Section\n\n[tbl-0.html](tbl-0.html)\n\nMore text.';
      const tables = [{ id: 'tbl-0.html', html: '<table><tr><td>A</td></tr></table>' }];

      const result = appendPageTables(md, tables);

      expect(result).toBe('## Section\n\n<table><tr><td>A</td></tr></table>\n\nMore text.');
    });

    it('replaces an image-link-style marker', () => {
      const md = '## Section\n\n![tbl-1.html](tbl-1.html)\n\nMore text.';
      const tables = [{ id: 'tbl-1.html', html: '<table><tr><td>B</td></tr></table>' }];

      const result = appendPageTables(md, tables);

      expect(result).toBe('## Section\n\n<table><tr><td>B</td></tr></table>\n\nMore text.');
    });

    it('replaces multiple markers in document order', () => {
      const md =
        'Intro.\n\n[tbl-0.html](tbl-0.html)\n\nMiddle.\n\n[tbl-1.html](tbl-1.html)\n\nEnd.';
      const tables = [
        { id: 'tbl-0.html', html: '<table><tr><td>First</td></tr></table>' },
        { id: 'tbl-1.html', html: '<table><tr><td>Second</td></tr></table>' },
      ];

      const result = appendPageTables(md, tables);

      expect(result).toBe(
        'Intro.\n\n<table><tr><td>First</td></tr></table>\n\nMiddle.\n\n<table><tr><td>Second</td></tr></table>\n\nEnd.',
      );
    });
  });

  describe('append fallback (no markers in markdown)', () => {
    it('appends a single table at the end when no marker is present', () => {
      const md = '## Section\n\nSome text.';
      const tables = [{ id: 'tbl-0.html', html: '<table><tr><td>A</td></tr></table>' }];

      const result = appendPageTables(md, tables);

      expect(result).toBe('## Section\n\nSome text.\n\n<table><tr><td>A</td></tr></table>');
    });

    it('appends multiple tables in document order when no markers present', () => {
      const md = 'Intro text.';
      const tables = [
        { id: 'tbl-0.html', html: '<table><tr><td>First</td></tr></table>' },
        { id: 'tbl-1.html', html: '<table><tr><td>Second</td></tr></table>' },
      ];

      const result = appendPageTables(md, tables);

      expect(result).toBe(
        'Intro text.\n\n<table><tr><td>First</td></tr></table>\n\n<table><tr><td>Second</td></tr></table>',
      );
    });

    it('handles empty markdown with a table', () => {
      const tables = [{ id: 'tbl-0.html', html: '<table><tr><td>X</td></tr></table>' }];

      expect(appendPageTables('', tables)).toBe('\n\n<table><tr><td>X</td></tr></table>');
    });
  });

  describe('mixed: some markers found, some not', () => {
    it('replaces found marker and appends unmatched table', () => {
      const md = 'Text.\n\n[tbl-0.html](tbl-0.html)\n\nEnd.';
      const tables = [
        { id: 'tbl-0.html', html: '<table><tr><td>Placed</td></tr></table>' },
        { id: 'tbl-1.html', html: '<table><tr><td>Appended</td></tr></table>' },
      ];

      const result = appendPageTables(md, tables);

      expect(result).toBe(
        'Text.\n\n<table><tr><td>Placed</td></tr></table>\n\nEnd.\n\n<table><tr><td>Appended</td></tr></table>',
      );
    });
  });

  describe('no-op cases', () => {
    it('returns markdown unchanged when tables array is empty', () => {
      expect(appendPageTables('No tables here.', [])).toBe('No tables here.');
    });

    it('returns markdown unchanged when tables is undefined', () => {
      expect(appendPageTables('No tables here.', undefined)).toBe('No tables here.');
    });

    it('returns markdown unchanged when tables is null', () => {
      expect(appendPageTables('No tables here.', null as unknown as undefined)).toBe(
        'No tables here.',
      );
    });
  });
});
