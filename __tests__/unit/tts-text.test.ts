import { describe, it, expect } from 'vitest';
import {
  prepareArticleForTTS,
  prepareArticleFromHtml,
  detectLanguage,
  mapWordsToDOM,
} from '@/lib/tts-text';

describe('prepareArticleForTTS', () => {
  it('splits text by double newlines into paragraphs', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
    const result = prepareArticleForTTS(text);
    expect(result).toHaveLength(3);
    expect(result[0]!.text).toBe('First paragraph.');
    expect(result[1]!.text).toBe('Second paragraph.');
    expect(result[2]!.text).toBe('Third paragraph.');
  });

  it('assigns sequential indices', () => {
    const text = 'Para one.\n\nPara two.';
    const result = prepareArticleForTTS(text);
    expect(result[0]!.index).toBe(0);
    expect(result[1]!.index).toBe(1);
  });

  it('computes word count for each paragraph', () => {
    const text = 'One two three.\n\nFour five.';
    const result = prepareArticleForTTS(text);
    expect(result[0]!.wordCount).toBe(3);
    expect(result[1]!.wordCount).toBe(2);
  });

  it('skips empty paragraphs', () => {
    const text = 'First.\n\n\n\n\n\nSecond.';
    const result = prepareArticleForTTS(text);
    expect(result).toHaveLength(2);
  });

  it('trims whitespace from paragraphs', () => {
    const text = '  Hello world.  \n\n  Goodbye.  ';
    const result = prepareArticleForTTS(text);
    expect(result[0]!.text).toBe('Hello world.');
    expect(result[1]!.text).toBe('Goodbye.');
  });

  it('returns empty array for empty input', () => {
    expect(prepareArticleForTTS('')).toHaveLength(0);
    expect(prepareArticleForTTS('   ')).toHaveLength(0);
  });

  it('handles single paragraph', () => {
    const text = 'Just one paragraph with no line breaks.';
    const result = prepareArticleForTTS(text);
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe(text);
  });

  it('splits paragraphs exceeding 2000 chars at sentence boundaries', () => {
    // Create a paragraph with ~2500 chars
    const sentence = 'This is a test sentence that is about fifty characters long. ';
    const longParagraph = sentence.repeat(50); // ~3000 chars
    const result = prepareArticleForTTS(longParagraph);
    expect(result.length).toBeGreaterThan(1);
    for (const p of result) {
      expect(p.text.length).toBeLessThanOrEqual(2000);
    }
  });

  it('handles unicode text', () => {
    const text = 'Les caractères spéciaux: é, è, ê, ë.\n\nDeuxième paragraphe avec des accents.';
    const result = prepareArticleForTTS(text);
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toContain('é');
  });
});

describe('prepareArticleFromHtml', () => {
  it('extracts text from <p> elements', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p>';
    const result = prepareArticleFromHtml(html, '');
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toBe('First paragraph.');
    expect(result[1]!.text).toBe('Second paragraph.');
  });

  it('extracts text from mixed block elements', () => {
    const html = '<h1>Title</h1><p>Body text.</p><li>List item.</li>';
    const result = prepareArticleFromHtml(html, '');
    expect(result).toHaveLength(3);
    expect(result[0]!.text).toBe('Title');
    expect(result[1]!.text).toBe('Body text.');
    expect(result[2]!.text).toBe('List item.');
  });

  it('strips nested inline tags from text', () => {
    const html = '<p>Text with <strong>bold</strong> and <em>italic</em> words.</p>';
    const result = prepareArticleFromHtml(html, '');
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe('Text with bold and italic words.');
  });

  it('decodes HTML entities', () => {
    const html = '<p>Tom &amp; Jerry &mdash; a classic.</p>';
    const result = prepareArticleFromHtml(html, '');
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toContain('Tom & Jerry');
  });

  it('skips empty blocks', () => {
    const html = '<p>Text.</p><p>   </p><p>More text.</p>';
    const result = prepareArticleFromHtml(html, '');
    expect(result).toHaveLength(2);
  });

  it('falls back to contentText when HTML has no block elements', () => {
    const html = '<span>inline only</span>';
    const contentText = 'First.\n\nSecond.';
    const result = prepareArticleFromHtml(html, contentText);
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toBe('First.');
  });

  it('falls back to contentText when HTML is empty', () => {
    const result = prepareArticleFromHtml('', 'Fallback text.');
    expect(result).toHaveLength(1);
    expect(result[0]!.text).toBe('Fallback text.');
  });

  it('assigns sequential indices', () => {
    const html = '<p>A</p><p>B</p><p>C</p>';
    const result = prepareArticleFromHtml(html, '');
    expect(result[0]!.index).toBe(0);
    expect(result[1]!.index).toBe(1);
    expect(result[2]!.index).toBe(2);
  });

  it('handles article 890 style mismatch correctly', () => {
    const html =
      '<p data-testid="para-1">This is the first paragraph of a test article.</p>' +
      '<p data-testid="para-2">This is the second paragraph with different content.</p>';
    const contentText = 'This is the first paragraph. This is the second paragraph.';
    const result = prepareArticleFromHtml(html, contentText);
    // Should use HTML, producing 2 paragraphs matching the DOM
    expect(result).toHaveLength(2);
    expect(result[0]!.text).toBe('This is the first paragraph of a test article.');
    expect(result[1]!.text).toBe('This is the second paragraph with different content.');
  });
});

describe('detectLanguage', () => {
  it('returns "en" for English text', () => {
    const text =
      'The quick brown fox jumps over the lazy dog. This is a simple English sentence with common words.';
    expect(detectLanguage(text)).toBe('en');
  });

  it('returns "fr" for French text', () => {
    const text =
      "Le renard brun et rapide saute par-dessus le chien paresseux. C'est une phrase simple en français avec des mots courants dans la langue française.";
    expect(detectLanguage(text)).toBe('fr');
  });

  it('returns "en" for empty text', () => {
    expect(detectLanguage('')).toBe('en');
  });

  it('returns "en" for mixed language with majority English', () => {
    const text =
      'This is an English article. It discusses many topics. The main ideas are presented clearly. It has some French words like bonjour.';
    expect(detectLanguage(text)).toBe('en');
  });
});

describe('mapWordsToDOM', () => {
  it('maps words to correct character offsets', () => {
    const text = 'Hello world today';
    const words = ['Hello', 'world', 'today'];
    const result = mapWordsToDOM(text, words);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ word: 'Hello', startOffset: 0, endOffset: 5 });
    expect(result[1]).toEqual({ word: 'world', startOffset: 6, endOffset: 11 });
    expect(result[2]).toEqual({ word: 'today', startOffset: 12, endOffset: 17 });
  });

  it('handles punctuation attached to words', () => {
    const text = 'Hello, world!';
    const words = ['Hello,', 'world!'];
    const result = mapWordsToDOM(text, words);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ word: 'Hello,', startOffset: 0, endOffset: 6 });
    expect(result[1]).toEqual({ word: 'world!', startOffset: 7, endOffset: 13 });
  });

  it('handles extra whitespace in source text', () => {
    const text = 'Hello   world';
    const words = ['Hello', 'world'];
    const result = mapWordsToDOM(text, words);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ word: 'Hello', startOffset: 0, endOffset: 5 });
    expect(result[1]).toEqual({ word: 'world', startOffset: 8, endOffset: 13 });
  });

  it('returns empty array for empty inputs', () => {
    expect(mapWordsToDOM('', [])).toHaveLength(0);
    expect(mapWordsToDOM('Hello', [])).toHaveLength(0);
  });

  it('handles TTS words that differ slightly from source (stripped punctuation)', () => {
    const text = '"Hello," said the fox.';
    // TTS might strip outer quotes
    const words = ['Hello,', 'said', 'the', 'fox.'];
    const result = mapWordsToDOM(text, words);
    expect(result.length).toBeGreaterThan(0);
    // Each mapped word should be findable in the text
    for (const pos of result) {
      expect(text.substring(pos.startOffset, pos.endOffset)).toContain(
        pos.word.replace(/["""]/g, ''),
      );
    }
  });
});
