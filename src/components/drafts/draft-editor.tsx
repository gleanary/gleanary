'use client';

import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';
import { sanitizeArticleHtml } from '@/lib/sanitize';

interface DraftEditorProps {
  value: string;
  onChange: (value: string) => void;
  isStreaming: boolean;
  streamedText: string;
  isPreview: boolean;
}

/**
 * The editable body of a draft. Switches between a plain `<textarea>` and a
 * rendered markdown preview. While streaming, the textarea is read-only and
 * mirrors `streamedText`; an effect pins scroll to the bottom so freshly
 * generated text stays visible. Preview HTML is run through marked + DOMPurify
 * before reaching `dangerouslySetInnerHTML`.
 */
export function DraftEditor({
  value,
  onChange,
  isStreaming,
  streamedText,
  isPreview,
}: DraftEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [previewHtml, setPreviewHtml] = useState('');

  useEffect(() => {
    if (!isStreaming) return;
    const el = textareaRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streamedText, isStreaming]);

  useEffect(() => {
    if (!isPreview) return;
    let cancelled = false;
    (async () => {
      const html = await marked.parse(value);
      if (cancelled) return;
      setPreviewHtml(sanitizeArticleHtml(html));
    })();
    return () => {
      cancelled = true;
    };
  }, [isPreview, value]);

  if (isPreview) {
    return (
      <div
        data-testid="draft-preview"
        className="bg-card border-border prose prose-sm dark:prose-invert min-h-[70vh] max-w-none overflow-y-auto rounded-md border px-4 py-3"
        dangerouslySetInnerHTML={{ __html: previewHtml }}
      />
    );
  }

  const displayed = isStreaming ? streamedText : value;

  return (
    <textarea
      ref={textareaRef}
      data-testid="draft-editor"
      value={displayed}
      onChange={(e) => onChange(e.target.value)}
      readOnly={isStreaming}
      placeholder={isStreaming ? 'Generating…' : 'Start writing…'}
      className="bg-card border-border text-foreground focus:ring-ring min-h-[70vh] w-full resize-none rounded-md border px-4 py-3 font-serif text-base leading-relaxed focus:ring-1 focus:outline-none"
    />
  );
}
