import { describe, it, expect } from 'vitest';
import {
  postProcessHtml,
  removeTrackingPixels,
  removeEmptyElements,
  unwrapLayoutTables,
  wrapConsecutiveImages,
  collapseRedundantWrappers,
  stripPageNumbers,
  stripRepeatingHeaders,
  TRACKING_DOMAINS,
  TRACKING_PATH_SEGMENTS,
  CONSECUTIVE_IMAGE_THRESHOLD,
} from '@/lib/html-post-processor';
import { JSDOM } from 'jsdom';

/** Helper: run a single transform on HTML and return body innerHTML. */
function applyTransform(html: string, fn: (doc: Document) => void): string {
  const dom = new JSDOM(html);
  fn(dom.window.document);
  return dom.window.document.body?.innerHTML ?? '';
}

// ---------------------------------------------------------------------------
// Transform 1: Tracking pixel removal
// ---------------------------------------------------------------------------

describe('removeTrackingPixels', () => {
  it('removes 1x1 pixel images without alt text', () => {
    const result = applyTransform(
      '<body><img src="https://example.com/t.gif" width="1" height="1"></body>',
      removeTrackingPixels,
    );
    expect(result).not.toContain('t.gif');
  });

  it('removes images with width=1 and no height', () => {
    const result = applyTransform(
      '<body><img src="https://example.com/t.gif" width="1"></body>',
      removeTrackingPixels,
    );
    expect(result).not.toContain('t.gif');
  });

  it('preserves 1x1 images with alt text', () => {
    const result = applyTransform(
      '<body><img src="https://example.com/t.gif" width="1" height="1" alt="icon"></body>',
      removeTrackingPixels,
    );
    expect(result).toContain('t.gif');
  });

  it('removes images from known tracking domains', () => {
    for (const domain of TRACKING_DOMAINS.slice(0, 3)) {
      const result = applyTransform(
        `<body><img src="https://track.${domain}/open.gif" width="100" height="50"></body>`,
        removeTrackingPixels,
      );
      expect(result).not.toContain(domain);
    }
  });

  it('removes images with known tracking path segments', () => {
    for (const seg of TRACKING_PATH_SEGMENTS) {
      const result = applyTransform(
        `<body><img src="https://example.com${seg}?id=123" width="100" height="50"></body>`,
        removeTrackingPixels,
      );
      expect(result).not.toContain(seg);
    }
  });

  it('preserves normal content images', () => {
    const result = applyTransform(
      '<body><img src="https://example.com/photo.jpg" width="800" height="600" alt="Photo"></body>',
      removeTrackingPixels,
    );
    expect(result).toContain('photo.jpg');
  });
});

// ---------------------------------------------------------------------------
// Transform 2: Empty element removal
// ---------------------------------------------------------------------------

describe('removeEmptyElements', () => {
  it('removes whitespace-only <div>', () => {
    const result = applyTransform(
      '<body><p>Hello</p><div>   </div><p>World</p></body>',
      removeEmptyElements,
    );
    expect(result).not.toContain('<div');
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  it('removes whitespace-only <p>', () => {
    const result = applyTransform(
      '<body><p>Hello</p><p>  \n  </p><p>World</p></body>',
      removeEmptyElements,
    );
    // Should have exactly 2 <p> tags
    expect(result.match(/<p>/g)?.length).toBe(2);
  });

  it('removes whitespace-only <span>', () => {
    const result = applyTransform(
      '<body><p>Hello <span>  </span> World</p></body>',
      removeEmptyElements,
    );
    expect(result).not.toContain('<span');
  });

  it('removes &nbsp;-only elements', () => {
    const result = applyTransform(
      '<body><div>\u00a0</div><p>Content</p></body>',
      removeEmptyElements,
    );
    expect(result).not.toContain('<div');
    expect(result).toContain('Content');
  });

  it('preserves elements with text content', () => {
    const result = applyTransform('<body><div>Real content</div></body>', removeEmptyElements);
    expect(result).toContain('<div>Real content</div>');
  });

  it('preserves elements containing images', () => {
    const result = applyTransform(
      '<body><div><img src="photo.jpg" alt="photo"></div></body>',
      removeEmptyElements,
    );
    expect(result).toContain('<div>');
    expect(result).toContain('photo.jpg');
  });

  it('removes nested empty elements bottom-up', () => {
    const result = applyTransform(
      '<body><div><div><span>  </span></div></div><p>Content</p></body>',
      removeEmptyElements,
    );
    expect(result).not.toContain('<div');
    expect(result).not.toContain('<span');
    expect(result).toContain('Content');
  });
});

// ---------------------------------------------------------------------------
// Transform 3: Layout table unwrapping
// ---------------------------------------------------------------------------

describe('unwrapLayoutTables', () => {
  it('unwraps table with role="presentation"', () => {
    const result = applyTransform(
      '<body><table role="presentation"><tbody><tr><td><p>Article</p></td></tr></tbody></table></body>',
      unwrapLayoutTables,
    );
    expect(result).toContain('<p>Article</p>');
    expect(result).not.toContain('<table');
  });

  it('keeps data tables with <th> cells', () => {
    const result = applyTransform(
      '<body><table><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Alice</td></tr></tbody></table></body>',
      unwrapLayoutTables,
    );
    expect(result).toContain('<table');
    expect(result).toContain('Name');
  });

  it('keeps shallow tables without role=presentation', () => {
    const result = applyTransform(
      '<body><table><tr><td>Data</td></tr></table></body>',
      unwrapLayoutTables,
    );
    expect(result).toContain('<table');
  });

  it('unwraps deeply nested layout tables', () => {
    const html = `<body>
      <table><tr><td>
        <table><tr><td>
          <table><tr><td><p>Deep content</p></td></tr></table>
        </td></tr></table>
      </td></tr></table>
    </body>`;
    const result = applyTransform(html, unwrapLayoutTables);
    expect(result).toContain('Deep content');
  });
});

// ---------------------------------------------------------------------------
// Transform 4: Consecutive image wrapping
// ---------------------------------------------------------------------------

describe('wrapConsecutiveImages', () => {
  it('wraps 4+ consecutive images in div.image-grid', () => {
    const imgs = Array.from({ length: 5 }, (_, i) => `<img src="img${i}.jpg" alt="img${i}">`).join(
      '',
    );
    const result = applyTransform(`<body>${imgs}</body>`, wrapConsecutiveImages);
    expect(result).toContain('class="image-grid"');
    expect(result).toContain('img0.jpg');
    expect(result).toContain('img4.jpg');
  });

  it('does not wrap fewer than 4 consecutive images', () => {
    const imgs = '<img src="a.jpg"><img src="b.jpg"><img src="c.jpg">';
    const result = applyTransform(`<body>${imgs}</body>`, wrapConsecutiveImages);
    expect(result).not.toContain('image-grid');
  });

  it('does not wrap images separated by text', () => {
    const html = `<body>
      <img src="a.jpg">
      <p>Some meaningful paragraph text here.</p>
      <img src="b.jpg">
      <p>Another paragraph of text content.</p>
      <img src="c.jpg">
      <p>Yet more text content here.</p>
      <img src="d.jpg">
    </body>`;
    const result = applyTransform(html, wrapConsecutiveImages);
    expect(result).not.toContain('image-grid');
  });

  it('wraps exactly at threshold of 4', () => {
    const imgs = Array.from(
      { length: CONSECUTIVE_IMAGE_THRESHOLD },
      (_, i) => `<img src="img${i}.jpg">`,
    ).join('');
    const result = applyTransform(`<body>${imgs}</body>`, wrapConsecutiveImages);
    expect(result).toContain('class="image-grid"');
  });

  it('ignores whitespace text nodes between images', () => {
    const html = `<body>
      <img src="a.jpg">
      <img src="b.jpg">
      <img src="c.jpg">
      <img src="d.jpg">
    </body>`;
    const result = applyTransform(html, wrapConsecutiveImages);
    expect(result).toContain('class="image-grid"');
  });

  it('treats <figure> wrapping <img> as image node', () => {
    const html = `<body>
      <figure><img src="a.jpg"></figure>
      <figure><img src="b.jpg"></figure>
      <figure><img src="c.jpg"></figure>
      <figure><img src="d.jpg"></figure>
    </body>`;
    const result = applyTransform(html, wrapConsecutiveImages);
    expect(result).toContain('class="image-grid"');
  });

  it('treats <a> wrapping <img> as image node', () => {
    const html = `<body>
      <a href="#"><img src="a.jpg"></a>
      <a href="#"><img src="b.jpg"></a>
      <a href="#"><img src="c.jpg"></a>
      <a href="#"><img src="d.jpg"></a>
    </body>`;
    const result = applyTransform(html, wrapConsecutiveImages);
    expect(result).toContain('class="image-grid"');
  });
});

// ---------------------------------------------------------------------------
// Transform 5: Redundant wrapper collapse
// ---------------------------------------------------------------------------

describe('collapseRedundantWrappers', () => {
  it('collapses div wrapper around a single <p>', () => {
    const result = applyTransform(
      '<body><div><p>Content</p></div></body>',
      collapseRedundantWrappers,
    );
    expect(result.trim()).toBe('<p>Content</p>');
  });

  it('preserves div with id attribute', () => {
    const result = applyTransform(
      '<body><div id="main"><p>Content</p></div></body>',
      collapseRedundantWrappers,
    );
    expect(result).toContain('<div id="main">');
  });

  it('preserves div with class attribute', () => {
    const result = applyTransform(
      '<body><div class="container"><p>Content</p></div></body>',
      collapseRedundantWrappers,
    );
    expect(result).toContain('<div class="container">');
  });

  it('preserves div with data-* attribute', () => {
    const result = applyTransform(
      '<body><div data-section="intro"><p>Content</p></div></body>',
      collapseRedundantWrappers,
    );
    expect(result).toContain('data-section');
  });

  it('collapses div with only style attribute (no semantic value)', () => {
    const result = applyTransform(
      '<body><div style="margin:0"><p>Content</p></div></body>',
      collapseRedundantWrappers,
    );
    expect(result.trim()).toBe('<p>Content</p>');
  });

  it('handles multiple nesting levels', () => {
    const result = applyTransform(
      '<body><div><div><div><p>Deep</p></div></div></div></body>',
      collapseRedundantWrappers,
    );
    expect(result.trim()).toBe('<p>Deep</p>');
  });

  it('preserves wrapper with significant text alongside child', () => {
    const result = applyTransform(
      '<body><div>Important text<p>Content</p></div></body>',
      collapseRedundantWrappers,
    );
    expect(result).toContain('Important text');
    expect(result).toContain('<div>');
  });

  it('preserves div with multiple children', () => {
    const result = applyTransform(
      '<body><div><p>First</p><p>Second</p></div></body>',
      collapseRedundantWrappers,
    );
    expect(result).toContain('<div>');
  });
});

// ---------------------------------------------------------------------------
// Integration: postProcessHtml
// ---------------------------------------------------------------------------

describe('postProcessHtml', () => {
  it('returns empty string as-is', () => {
    expect(postProcessHtml('')).toBe('');
  });

  it('returns whitespace-only string as-is', () => {
    expect(postProcessHtml('   ')).toBe('   ');
  });

  it('applies all transforms in sequence', () => {
    const html = `<body>
      <img src="https://track.mailchimp.com/open" width="1" height="1">
      <div>   </div>
      <div><p>Content here</p></div>
      <img src="a.jpg"><img src="b.jpg"><img src="c.jpg"><img src="d.jpg">
    </body>`;
    const result = postProcessHtml(html);

    // Tracking pixel removed
    expect(result).not.toContain('mailchimp');
    // Empty div removed
    // Wrapper collapsed
    expect(result).toContain('Content here');
    // Image grid wrapped
    expect(result).toContain('class="image-grid"');
  });

  it('is idempotent', () => {
    // Use output of first pass as input to test true idempotency
    // (avoids JSDOM whitespace normalization differences between raw HTML and parsed HTML)
    const html =
      '<p>Hello world</p><img src="a.jpg"><img src="b.jpg"><img src="c.jpg"><img src="d.jpg"><div>   </div>';
    const first = postProcessHtml(html);
    const second = postProcessHtml(first);
    expect(second).toBe(first);
  });

  it('preserves clean content without modification', () => {
    const html = '<p>Hello, <strong>world</strong>!</p>';
    const result = postProcessHtml(html);
    expect(result).toContain('Hello');
    expect(result).toContain('<strong>world</strong>');
  });

  it('runs stripPageNumbers and stripRepeatingHeaders when isPdfContext: true', () => {
    const html =
      '<p>3</p><p>Article Title</p><p>Article Title</p><p>Article Title</p><p>Real content.</p><p>4</p>';
    const result = postProcessHtml(html, { isPdfContext: true });
    expect(result).not.toContain('>3<');
    expect(result).not.toContain('>4<');
    expect(result).not.toContain('Article Title');
    expect(result).toContain('Real content');
  });

  it('does not run PDF rules when isPdfContext is absent', () => {
    const html = '<p>3</p><p>Normal content.</p>';
    const result = postProcessHtml(html);
    expect(result).toContain('>3<');
  });
});

// ---------------------------------------------------------------------------
// PDF-specific transforms: stripPageNumbers
// ---------------------------------------------------------------------------

describe('stripPageNumbers', () => {
  it('removes standalone digit paragraphs', () => {
    const result = applyTransform('<body><p>3</p><p>Content</p></body>', stripPageNumbers);
    expect(result).not.toMatch(/>3</);
    expect(result).toContain('Content');
  });

  it('removes "Page N" paragraphs', () => {
    const result = applyTransform('<body><p>Page 3</p><p>Content</p></body>', stripPageNumbers);
    expect(result).not.toContain('Page 3');
    expect(result).toContain('Content');
  });

  it('removes "N of M" paragraphs', () => {
    const result = applyTransform('<body><p>3 of 42</p><p>Content</p></body>', stripPageNumbers);
    expect(result).not.toContain('3 of 42');
  });

  it('removes "page N of M" paragraphs (case-insensitive)', () => {
    const result = applyTransform(
      '<body><p>Page 3 of 42</p><p>Content</p></body>',
      stripPageNumbers,
    );
    expect(result).not.toContain('Page 3 of 42');
  });

  it('removes "N/M" fraction-style page numbers', () => {
    const result = applyTransform('<body><p>3/42</p><p>Content</p></body>', stripPageNumbers);
    expect(result).not.toContain('3/42');
  });

  it('removes "- N -" style page numbers', () => {
    const result = applyTransform('<body><p>- 3 -</p><p>Content</p></body>', stripPageNumbers);
    expect(result).not.toContain('- 3 -');
  });

  it('removes "– N –" (en-dash) style page numbers', () => {
    const result = applyTransform('<body><p>– 3 –</p><p>Content</p></body>', stripPageNumbers);
    expect(result).not.toContain('– 3 –');
  });

  it('does NOT remove "3rd party" — not a page number', () => {
    const result = applyTransform('<body><p>3rd party</p></body>', stripPageNumbers);
    expect(result).toContain('3rd party');
  });

  it('does NOT remove paragraphs with only text content', () => {
    const result = applyTransform('<body><p>Introduction</p></body>', stripPageNumbers);
    expect(result).toContain('Introduction');
  });
});

// ---------------------------------------------------------------------------
// PDF-specific transforms: stripRepeatingHeaders
// ---------------------------------------------------------------------------

describe('stripRepeatingHeaders', () => {
  it('removes paragraphs that appear 3+ times', () => {
    const html =
      '<body>' +
      '<p>Document Title</p><p>Content A</p>' +
      '<p>Document Title</p><p>Content B</p>' +
      '<p>Document Title</p><p>Content C</p>' +
      '</body>';
    const result = applyTransform(html, stripRepeatingHeaders);
    expect(result).not.toContain('Document Title');
    expect(result).toContain('Content A');
    expect(result).toContain('Content B');
    expect(result).toContain('Content C');
  });

  it('keeps paragraphs that appear only twice (below threshold)', () => {
    const html =
      '<body>' +
      '<p>Section Header</p><p>Content A</p>' +
      '<p>Section Header</p><p>Content B</p>' +
      '</body>';
    const result = applyTransform(html, stripRepeatingHeaders);
    expect(result).toContain('Section Header');
  });

  it('keeps unique content regardless of frequency', () => {
    const html =
      '<body>' +
      '<p>Unique para one</p>' +
      '<p>Unique para two</p>' +
      '<p>Unique para three</p>' +
      '</body>';
    const result = applyTransform(html, stripRepeatingHeaders);
    expect(result).toContain('Unique para one');
    expect(result).toContain('Unique para two');
    expect(result).toContain('Unique para three');
  });

  it('does not trigger for single-page docs (no repeating elements)', () => {
    const html = '<body><p>Title</p><p>Body text that spans the whole page.</p></body>';
    const result = applyTransform(html, stripRepeatingHeaders);
    expect(result).toContain('Title');
    expect(result).toContain('Body text');
  });

  it('ignores long paragraphs (> 100 chars)', () => {
    const longText = 'A'.repeat(101);
    const html =
      `<body><p>${longText}</p><p>${longText}</p><p>${longText}</p>` + `<p>${longText}</p></body>`;
    const result = applyTransform(html, stripRepeatingHeaders);
    expect(result).toContain(longText.slice(0, 20));
  });

  it('normalizes whitespace when comparing', () => {
    const html =
      '<body>' +
      '<p>  Running  Header  </p><p>Content A</p>' +
      '<p>Running Header</p><p>Content B</p>' +
      '<p>Running  Header</p><p>Content C</p>' +
      '</body>';
    const result = applyTransform(html, stripRepeatingHeaders);
    expect(result).not.toContain('Running');
    expect(result).toContain('Content A');
  });

  it('is case-insensitive when comparing', () => {
    const html =
      '<body>' +
      '<p>MY DOCUMENT</p><p>Content A</p>' +
      '<p>My Document</p><p>Content B</p>' +
      '<p>my document</p><p>Content C</p>' +
      '</body>';
    const result = applyTransform(html, stripRepeatingHeaders);
    expect(result).not.toContain('Document');
    expect(result).toContain('Content A');
  });
});
