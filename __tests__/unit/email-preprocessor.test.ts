import { describe, it, expect } from 'vitest';
import { preprocessEmailHtml } from '@/lib/email-preprocessor';

describe('preprocessEmailHtml', () => {
  // --- Tracking pixel removal ---

  it('removes 1x1 pixel images by width/height attributes', () => {
    const html =
      '<body><p>Hello</p><img src="https://example.com/open.gif" width="1" height="1"></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('Hello');
    expect(result).not.toContain('open.gif');
  });

  it('removes images with known tracking domain in src', () => {
    const html =
      '<body><p>Content</p><img src="https://track.mailchimp.com/open.php?id=123"></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('Content');
    expect(result).not.toContain('mailchimp.com');
  });

  it('removes sendgrid tracking pixel', () => {
    const html =
      '<body><img src="https://u12345.ct.sendgrid.net/wf/open" width="1" height="1"></body>';
    const result = preprocessEmailHtml(html);
    expect(result).not.toContain('sendgrid');
  });

  it('preserves non-tracking images', () => {
    const html =
      '<body><img src="https://example.com/logo.png" width="100" height="50" alt="Logo"></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('logo.png');
  });

  it('preserves meaningful small images with alt text', () => {
    // Small but has alt and reasonable src - keep it (conservative heuristic)
    const html =
      '<body><img src="https://example.com/icon.png" width="16" height="16" alt="Icon"></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('icon.png');
  });

  // --- MSO conditional removal ---

  it('removes downlevel-hidden MSO conditionals', () => {
    const html =
      '<body><p>Hello</p><!--[if mso]><table><tr><td>MSO table</td></tr></table><![endif]--><p>World</p></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('Hello');
    expect(result).toContain('World');
    expect(result).not.toContain('MSO table');
  });

  it('removes multi-line MSO conditionals', () => {
    const html = `<body><p>Text</p><!--[if mso gt 15]>
<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml">
  <v:fill type="solid"/>
</v:roundrect>
<![endif]--><p>After</p></body>`;
    const result = preprocessEmailHtml(html);
    expect(result).not.toContain('v:roundrect');
    expect(result).toContain('After');
  });

  // --- Spacer element removal ---

  it('removes td containing only &nbsp;', () => {
    const html = '<body><table><tr><td>Real content</td><td>&nbsp;</td></tr></table></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('Real content');
    // The nbsp-only cell should be gone
    const nbspCount = (result.match(/&nbsp;/g) ?? []).length;
    expect(nbspCount).toBe(0);
  });

  it('removes div containing only whitespace', () => {
    const html = '<body><p>Hello</p><div>   \n   </div><p>World</p></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('Hello');
    expect(result).toContain('World');
  });

  // --- Layout table unwrapping ---

  it('unwraps table with role="presentation"', () => {
    const html =
      '<body><table role="presentation"><tbody><tr><td><p>Article text</p></td></tr></tbody></table></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('Article text');
    // The outer table wrapper should be removed (no table tag for this content)
    // The p tag content should still be there
    expect(result).toContain('<p>Article text</p>');
  });

  it('keeps data tables with <th> cells', () => {
    const html =
      '<body><table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('<table');
    expect(result).toContain('Name');
    expect(result).toContain('Value');
  });

  it('keeps tables at 1-2 nesting levels (not deeply nested)', () => {
    // A shallow table without role=presentation should be kept
    const html = '<body><table><tr><td>Data</td></tr></table></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('Data');
    // Not unwrapped at shallow depth without role=presentation
    expect(result).toContain('<table');
  });

  it('unwraps deeply nested (3+) layout tables without th', () => {
    // 3 levels of nesting without th — should unwrap innermost
    const html = `<body>
      <table><tr><td>
        <table><tr><td>
          <table><tr><td><p>Deep content</p></td></tr></table>
        </td></tr></table>
      </td></tr></table>
    </body>`;
    const result = preprocessEmailHtml(html);
    expect(result).toContain('Deep content');
  });

  // --- Semantic element preservation ---

  it('preserves blockquote', () => {
    const html = '<body><blockquote><p>Quoted text</p></blockquote></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('<blockquote');
    expect(result).toContain('Quoted text');
  });

  it('preserves headings', () => {
    const html = '<body><h1>Title</h1><h2>Subtitle</h2><p>Body</p></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('<h1>Title</h1>');
    expect(result).toContain('<h2>Subtitle</h2>');
  });

  it('preserves lists', () => {
    const html = '<body><ul><li>Item 1</li><li>Item 2</li></ul></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('<ul>');
    expect(result).toContain('Item 1');
    expect(result).toContain('Item 2');
  });

  it('preserves links', () => {
    const html = '<body><a href="https://example.com">Click here</a></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('Click here');
  });

  it('preserves figure and figcaption', () => {
    const html =
      '<body><figure><img src="https://example.com/photo.jpg" alt="Photo"><figcaption>A photo</figcaption></figure></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('photo.jpg');
    expect(result).toContain('A photo');
  });

  // --- Edge cases ---

  it('returns empty string for empty input', () => {
    const result = preprocessEmailHtml('');
    expect(result).toBe('');
  });

  it('passes through simple HTML without modification', () => {
    const html = '<body><p>Hello, <strong>world</strong>!</p></body>';
    const result = preprocessEmailHtml(html);
    expect(result).toContain('Hello');
    expect(result).toContain('<strong>world</strong>');
  });

  it('handles real-world newsletter structure: Substack-style', () => {
    const html = `<body>
      <!--[if mso]><table><tr><td><![endif]-->
      <div style="max-width:600px">
        <table role="presentation" cellpadding="0" cellspacing="0">
          <tr>
            <td>&nbsp;</td>
            <td>
              <h2>Weekly Update</h2>
              <p>Here is the <a href="https://example.com/article">article link</a>.</p>
              <img src="https://track.example.com/open/abc123" width="1" height="1" alt="">
            </td>
            <td>&nbsp;</td>
          </tr>
        </table>
      </div>
      <!--[if mso]><![endif]-->
    </body>`;
    const result = preprocessEmailHtml(html);
    expect(result).toContain('Weekly Update');
    expect(result).toContain('article link');
    expect(result).not.toContain('track.example.com');
    expect(result).not.toContain('[if mso]');
  });
});
