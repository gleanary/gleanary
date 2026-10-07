'use client';

import { useState, useRef, useEffect } from 'react';
import { SendHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ANTHROPIC_MODELS } from '@/lib/models';

interface Props {
  onSend: (message: string) => void;
  model: string;
  onModelChange: (model: string) => void;
  disabled?: boolean;
  /** Pre-filled message text (e.g., from URL params) */
  defaultValue?: string;
}

/**
 * Chat input with auto-resizing textarea and model selector.
 * Enter sends, Shift+Enter adds a newline.
 * @param props.onSend - Callback when user submits a message
 * @param props.model - Currently selected Anthropic model ID
 * @param props.onModelChange - Callback when user changes the model
 * @param props.disabled - Whether input is disabled (e.g., while streaming)
 */
export function ChatInput({ onSend, model, onModelChange, disabled, defaultValue }: Props) {
  const [value, setValue] = useState(defaultValue ?? '');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }, [value]);

  // Focus on mount
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  function handleSubmit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  const selectedModel = ANTHROPIC_MODELS.find((m) => m.id === model);

  return (
    <div className="bg-muted/50 border-border flex flex-col gap-2 rounded-xl border p-2">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Ask a question about your reading..."
        disabled={disabled}
        rows={1}
        className="placeholder:text-muted-foreground max-h-[200px] min-h-[40px] w-full resize-none bg-transparent px-2 py-1.5 text-sm outline-none disabled:opacity-50"
      />
      <div className="flex items-center justify-between gap-2">
        <Select value={model} onValueChange={onModelChange} disabled={disabled}>
          <SelectTrigger className="h-7 w-auto gap-1 border-0 bg-transparent px-2 text-xs shadow-none focus:ring-0">
            <SelectValue>{selectedModel?.name ?? model}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {ANTHROPIC_MODELS.map((m) => (
              <SelectItem key={m.id} value={m.id} className="text-xs">
                {m.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={disabled || !value.trim()}
          className="shrink-0"
        >
          <SendHorizontal size={16} />
        </Button>
      </div>
    </div>
  );
}
