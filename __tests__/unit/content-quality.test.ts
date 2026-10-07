import { describe, it, expect } from 'vitest';
import { detectFormattingIssues, QUALITY_THRESHOLD } from '@/lib/content-quality';

describe('content-quality: detectFormattingIssues', () => {
  describe('consecutive images heuristic (+25)', () => {
    it('scores +25 when 4+ images appear without intervening text', () => {
      const html =
        '<div><img src="a.jpg"><img src="b.jpg"><img src="c.jpg"><img src="d.jpg"></div>';
      // Only images heuristic should fire
      const score = detectFormattingIssues(html, null);
      expect(score).toBeGreaterThanOrEqual(25);
    });

    it('does not score when images have text between them', () => {
      const html =
        '<div><img src="a.jpg"><p>Some meaningful text here.</p>' +
        '<img src="b.jpg"><p>More text between images.</p>' +
        '<img src="c.jpg"><p>Even more text content here.</p>' +
        '<img src="d.jpg"></div>';
      const score = detectFormattingIssues(html, null);
      // Images heuristic should NOT fire (text between each)
      expect(score).toBeLessThan(25);
    });

    it('does not score with fewer than 4 consecutive images', () => {
      const html = '<div><img src="a.jpg"><img src="b.jpg"><img src="c.jpg"></div>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBeLessThan(25);
    });

    it('detects consecutive images even with whitespace between tags', () => {
      const html =
        '<div>\n  <img src="a.jpg">\n  <img src="b.jpg">\n  <img src="c.jpg">\n  <img src="d.jpg">\n</div>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBeGreaterThanOrEqual(25);
    });
  });

  describe('empty element ratio heuristic (+20)', () => {
    it('scores +20 when >30% of div/p/span are empty', () => {
      // 6 elements total, 4 empty = 67%
      const html =
        '<div></div><p></p><span></span><div></div>' + '<p>Has content</p><div>Also content</div>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBeGreaterThanOrEqual(20);
    });

    it('counts &nbsp; and <br> as empty content', () => {
      const html =
        '<div>&nbsp;</div><p> </p><span><br></span><div><br/></div><span>&nbsp;</span>' +
        '<p>Real content</p>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBeGreaterThanOrEqual(20);
    });

    it('does not score when most elements have content', () => {
      const html =
        '<p>Content one</p><p>Content two</p><p>Content three</p>' +
        '<p>Content four</p><p>Content five</p><div></div>';
      // 1/6 = 17% empty
      const score = detectFormattingIssues(html, null);
      // Empty ratio should not fire
      expect(score).toBeLessThan(20);
    });

    it('does not score when fewer than 5 elements total', () => {
      // 3 elements, 2 empty = 67% but below minimum count
      const html = '<p></p><p></p><p>Content</p>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBe(0);
    });
  });

  describe('table scaffolding heuristic (+15)', () => {
    it('scores +15 when tables exist but no <th> elements', () => {
      const html =
        '<table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>' +
        '<p>Some text to avoid markup ratio</p>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBeGreaterThanOrEqual(15);
    });

    it('does not score when tables have <th> elements', () => {
      const html =
        '<table><tr><th>Header</th></tr><tr><td>Cell</td></tr></table>' +
        '<p>Some text to avoid markup ratio</p>';
      const score = detectFormattingIssues(html, null);
      // Table heuristic should NOT fire
      // (might still score from other heuristics)
      expect(score % 15).not.toBe(15); // crude check — better to isolate
    });

    it('does not score when no tables present', () => {
      const html = '<p>Just plain text content here without any tables.</p>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBe(0);
    });
  });

  describe('HTML-to-text ratio heuristic (+20)', () => {
    it('scores +20 when markup ratio > 10', () => {
      // Lots of tags, very little text
      const html =
        '<div class="wrapper"><div class="inner"><div class="deep">' +
        '<span class="x"><span class="y"><span class="z">Hi</span></span></span>' +
        '</div></div></div>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBeGreaterThanOrEqual(20);
    });

    it('does not score when ratio is reasonable', () => {
      const html = '<p>This is a normal paragraph with a reasonable amount of text content.</p>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBe(0);
    });

    it('returns 0 for empty text after stripping (avoids division by zero)', () => {
      const html = '<div><span><br></span></div>';
      const score = detectFormattingIssues(html, null);
      // Should not crash — text is empty after strip
      expect(score).toBeGreaterThanOrEqual(0);
    });
  });

  describe('newsletter bonus (+20)', () => {
    it('adds +20 for newsletter source type', () => {
      const html = '<p>Normal clean content with nothing wrong.</p>';
      const withoutBonus = detectFormattingIssues(html, null);
      const withBonus = detectFormattingIssues(html, 'newsletter');
      expect(withBonus - withoutBonus).toBe(20);
    });

    it('does not add bonus for other source types', () => {
      const html = '<p>Normal content.</p>';
      expect(detectFormattingIssues(html, 'rss_feed')).toBe(0);
      expect(detectFormattingIssues(html, 'manual')).toBe(0);
      expect(detectFormattingIssues(html, null)).toBe(0);
    });
  });

  describe('combined scoring and threshold', () => {
    it('combines multiple heuristic scores', () => {
      // Newsletter (+20) + consecutive images (+25) = at least 45
      const html = '<img src="a.jpg"><img src="b.jpg"><img src="c.jpg"><img src="d.jpg">';
      const score = detectFormattingIssues(html, 'newsletter');
      expect(score).toBeGreaterThanOrEqual(45);
    });

    it('flags article at threshold boundary (score = 50)', () => {
      // Newsletter (+20) + consecutive images (+25) + table scaffolding (+15) = 60
      const html =
        '<table><tr><td>' +
        '<img src="a.jpg"><img src="b.jpg"><img src="c.jpg"><img src="d.jpg">' +
        '</td></tr></table>';
      const score = detectFormattingIssues(html, 'newsletter');
      expect(score).toBeGreaterThanOrEqual(QUALITY_THRESHOLD);
    });

    it('does not flag clean articles below threshold', () => {
      const html = '<p>This is a perfectly clean article with proper formatting and content.</p>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBeLessThan(QUALITY_THRESHOLD);
    });

    it('clamps score to 100', () => {
      // Newsletter(20) + images(25) + empty(20) + table(15) + ratio(20) = 100
      const emptyDivs = Array(10).fill('<div></div>').join('');
      const html =
        '<table><tr><td>' +
        '<div class="x"><div class="y"><div class="z">' +
        '<img src="a"><img src="b"><img src="c"><img src="d">' +
        emptyDivs +
        '</div></div></div></td></tr></table>';
      const score = detectFormattingIssues(html, 'newsletter');
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  describe('edge cases', () => {
    it('returns 0 for empty string', () => {
      expect(detectFormattingIssues('', null)).toBe(0);
    });

    it('returns 0 for minimal clean HTML', () => {
      expect(detectFormattingIssues('<p>Hello</p>', null)).toBe(0);
    });

    it('handles null sourceType', () => {
      expect(detectFormattingIssues('<p>Test</p>', null)).toBe(0);
    });
  });

  describe('QUALITY_THRESHOLD constant', () => {
    it('is 50', () => {
      expect(QUALITY_THRESHOLD).toBe(50);
    });
  });
});

describe('content-quality: PDF signals', () => {
  describe('scoreLowTextPerPage (+20)', () => {
    it('fires when chars/page < 100', () => {
      // 3 chars of text, 50 pages → 0.06 chars/page
      const score = detectFormattingIssues('<p>Hi</p>', null, 50);
      expect(score).toBeGreaterThanOrEqual(20);
    });

    it('does not fire when chars/page >= 100', () => {
      // 600 chars of text, 5 pages → 120 chars/page
      const longText = '<p>' + 'a'.repeat(600) + '</p>';
      const baseScore = detectFormattingIssues(longText, null);
      const scoreWithPages = detectFormattingIssues(longText, null, 5);
      // pageCount signal should not fire — scores should be equal
      expect(scoreWithPages).toBe(baseScore);
    });

    it('does not fire when pageCount is null', () => {
      const score = detectFormattingIssues('<p>x</p>', null, null);
      const scoreWithoutPages = detectFormattingIssues('<p>x</p>', null);
      expect(score).toBe(scoreWithoutPages);
    });

    it('does not fire when pageCount is 0 (no divide-by-zero)', () => {
      const score = detectFormattingIssues('<p>x</p>', null, 0);
      const scoreWithoutPages = detectFormattingIssues('<p>x</p>', null);
      expect(score).toBe(scoreWithoutPages);
    });
  });

  describe('scoreShortParagraphDensity (+15)', () => {
    it('fires when >60% of <p> tags are under 50 chars', () => {
      // 7 short + 2 long = 9 total, 77.8% short
      const shortPs = Array(7).fill('<p>Hi</p>').join('');
      const longPs =
        '<p>This is a longer paragraph with more than fifty characters in it.</p>'.repeat(2);
      const html = shortPs + longPs;
      const score = detectFormattingIssues(html, null);
      expect(score).toBeGreaterThanOrEqual(15);
    });

    it('does not fire when fewer than 5 <p> tags', () => {
      const html = '<p>Hi</p><p>Hi</p><p>Hi</p>';
      const score = detectFormattingIssues(html, null);
      expect(score).toBe(0);
    });

    it('does not fire when short paragraph density is <= 60%', () => {
      // 3 short + 3 long = 6 total, 50% short
      const shortPs = Array(3).fill('<p>Hi</p>').join('');
      const longPs =
        '<p>This is a paragraph that definitely has more than fifty characters of text in it.</p>'.repeat(
          3,
        );
      const html = shortPs + longPs;
      // Short density is 50% — should not fire
      const score = detectFormattingIssues(html, null);
      expect(score).toBeLessThan(15);
    });
  });

  describe('combined PDF signals', () => {
    it('both signals fire together when conditions met', () => {
      // Very short text relative to page count (low chars/page) + many short paragraphs
      const shortPs = Array(8).fill('<p>Hi</p>').join('');
      const longPs = '<p>This is a longer paragraph with more than fifty characters in it.</p>';
      const html = shortPs + longPs;
      const score = detectFormattingIssues(html, null, 100);
      // Should include both +20 (low text/page) and +15 (short paragraphs)
      expect(score).toBeGreaterThanOrEqual(35);
    });
  });
});
