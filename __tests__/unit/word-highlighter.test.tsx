/** @vitest-environment jsdom */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { WordHighlighter } from '@/components/reader/word-highlighter';

/**
 * Mount the real WordHighlighter against an imperatively built .article-content
 * container (React must not own its children, or re-renders would reset the
 * wrapped spans).
 */
function setup(html: string, words: string[]) {
  const content = document.createElement('div');
  content.className = 'article-content';
  content.innerHTML = html;
  document.body.appendChild(content);
  const contentRef = { current: content };

  const highlighter = (currentWordIndex: number) => (
    <WordHighlighter
      contentRef={contentRef}
      status="playing"
      currentParagraph={0}
      currentWordIndex={currentWordIndex}
      currentWords={words}
    />
  );
  const { rerender } = render(highlighter(0));

  return {
    /** Move playback to the given word and return the highlighted text. */
    highlight(index: number): string | null {
      rerender(highlighter(index));
      return content.querySelector('.tts-active-word')?.textContent ?? null;
    },
  };
}

const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  document.body.innerHTML = '';
});

afterAll(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe('WordHighlighter', () => {
  it('highlights the spoken word despite inline links, trailing commas and em dashes', () => {
    // Inworld-style tokens after the player hook dropped blanks/punctuation
    const words = ['Read', 'this', 'link', 'then', 'go', 'home', 'now'];
    const { highlight } = setup(
      '<p>Read <a href="#">this link</a>, then go — home now.</p>',
      words,
    );

    const expected = ['Read', 'this', 'link', 'then', 'go', 'home', 'now.'];
    expected.forEach((word, index) => {
      expect(highlight(index)).toBe(word);
    });
  });

  it('matches a block whose text begins with an emoji or punctuation', () => {
    const { highlight } = setup('<p>Another paragraph entirely.</p><p>👋 Hi, this is a test.</p>', [
      'Hi',
      'this',
      'is',
      'a',
      'test',
    ]);

    expect(highlight(0)).toBe('Hi,');
    expect(highlight(4)).toBe('test.');
  });
});
