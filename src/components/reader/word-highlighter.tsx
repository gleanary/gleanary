'use client';

import { useEffect, useRef } from 'react';
import type { TTSStatus } from '@/types';

const ACTIVE_CLASS = 'tts-active-word';
const WORD_ATTR = 'data-tts-word';
const BLOCK_SELECTORS = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, pre, td, th';

interface WordHighlighterProps {
  /** Ref to the .article-content container */
  contentRef: React.RefObject<HTMLDivElement | null>;
  status: TTSStatus;
  currentParagraph: number;
  currentWordIndex: number;
  /** Words from the TTS engine for the current paragraph, used for DOM matching */
  currentWords: string[];
}

/**
 * Manages word-by-word highlighting in article content during TTS playback.
 * Wraps text nodes in spans for the active paragraph and highlights the current word.
 * Renders nothing visible — operates imperatively via DOM manipulation.
 */
export function WordHighlighter({
  contentRef,
  status,
  currentParagraph,
  currentWordIndex,
  currentWords,
}: WordHighlighterProps) {
  const wrappedBlockRef = useRef<HTMLElement | null>(null);
  const wrappedParagraphRef = useRef<number>(-1);
  const prevWordRef = useRef<number>(-1);
  const lastScrollTimeRef = useRef<number>(0);

  // Wrap words when paragraph changes
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    if (status !== 'playing' && status !== 'paused') return;
    if (currentWords.length === 0) return;

    if (wrappedParagraphRef.current !== currentParagraph) {
      // Unwrap previous block
      if (wrappedBlockRef.current) {
        unwrapBlock(wrappedBlockRef.current);
        wrappedBlockRef.current = null;
      }

      // Reset word tracking for the new paragraph
      prevWordRef.current = -1;

      // Find the matching block by text content, not positional index
      const block = findBlockByText(container, currentWords);
      if (block) {
        wrapWordsInBlock(block);
        wrappedBlockRef.current = block;
        wrappedParagraphRef.current = currentParagraph;
      }
    }
  }, [contentRef, status, currentParagraph, currentWords]);

  // Highlight current word
  useEffect(() => {
    const container = contentRef.current;
    if (!container) return;
    if (status !== 'playing') return;

    // Remove previous highlight
    if (prevWordRef.current >= 0) {
      const prev = container.querySelector(`[${WORD_ATTR}="${prevWordRef.current}"]`);
      prev?.classList.remove(ACTIVE_CLASS);
    }

    // Add new highlight
    if (currentWordIndex >= 0) {
      const current = container.querySelector(`[${WORD_ATTR}="${currentWordIndex}"]`);
      if (current) {
        current.classList.add(ACTIVE_CLASS);
        // Throttle scrollIntoView to avoid layout thrashing (max once per 500ms)
        const now = Date.now();
        if (now - lastScrollTimeRef.current > 500) {
          current.scrollIntoView({ behavior: 'smooth', block: 'center' });
          lastScrollTimeRef.current = now;
        }
      }
    }

    prevWordRef.current = currentWordIndex;
  }, [contentRef, status, currentWordIndex]);

  // Cleanup on stop
  useEffect(() => {
    if (status === 'idle') {
      if (wrappedBlockRef.current) {
        unwrapBlock(wrappedBlockRef.current);
        wrappedBlockRef.current = null;
        wrappedParagraphRef.current = -1;
        prevWordRef.current = -1;
      }
    }
  }, [status]);

  return null;
}

/**
 * Finds the block element whose text content best matches the TTS words.
 * Uses the first few words as a fingerprint to locate the correct DOM block.
 */
function findBlockByText(container: HTMLElement, ttsWords: string[]): HTMLElement | null {
  if (ttsWords.length === 0) return null;

  const blocks = container.querySelectorAll<HTMLElement>(BLOCK_SELECTORS);
  if (blocks.length === 0) return null;

  // Build a search string from the first 5 TTS words (stripped of punctuation)
  const sampleSize = Math.min(5, ttsWords.length);
  const ttsFingerprint = ttsWords.slice(0, sampleSize).map(normalizeWord).join(' ');

  let bestBlock: HTMLElement | null = null;
  let bestScore = 0;

  for (const block of blocks) {
    const text = block.textContent ?? '';
    if (!text.trim()) continue;

    // Extract first N words from the block's text
    const blockWords = text.trim().split(/\s+/).slice(0, sampleSize);
    const blockFingerprint = blockWords.map(normalizeWord).join(' ');

    // Score based on common prefix length
    const score = commonPrefixLength(ttsFingerprint, blockFingerprint);
    if (score > bestScore) {
      bestScore = score;
      bestBlock = block;
    }
  }

  // Require at least a reasonable match (half the fingerprint)
  if (bestScore < ttsFingerprint.length * 0.4) return null;

  return bestBlock;
}

/** Normalizes a word for comparison: lowercase, strip punctuation */
function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Returns the length of the common prefix between two strings */
function commonPrefixLength(a: string, b: string): number {
  const len = Math.min(a.length, b.length);
  let i = 0;
  while (i < len && a[i] === b[i]) i++;
  return i;
}

/** Wraps each word in a block element with a span for highlighting */
function wrapWordsInBlock(block: HTMLElement): void {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
  const textNodes: Text[] = [];

  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.textContent?.trim()) {
      textNodes.push(node as Text);
    }
  }

  let wordIndex = 0;

  for (const textNode of textNodes) {
    const text = textNode.textContent ?? '';
    const parent = textNode.parentNode;
    if (!parent) continue;

    // Split text into words and whitespace
    const parts = text.split(/(\s+)/);
    const fragment = document.createDocumentFragment();

    for (const part of parts) {
      if (/^\s+$/.test(part) || part === '') {
        fragment.appendChild(document.createTextNode(part));
      } else {
        const span = document.createElement('span');
        span.setAttribute(WORD_ATTR, String(wordIndex));
        span.textContent = part;
        fragment.appendChild(span);
        wordIndex++;
      }
    }

    parent.replaceChild(fragment, textNode);
  }
}

/** Unwraps word spans in a block, restoring original text nodes */
function unwrapBlock(block: HTMLElement): void {
  const spans = block.querySelectorAll(`[${WORD_ATTR}]`);
  for (const span of spans) {
    const text = document.createTextNode(span.textContent ?? '');
    span.parentNode?.replaceChild(text, span);
  }

  // Normalize to merge adjacent text nodes
  block.normalize();
}
