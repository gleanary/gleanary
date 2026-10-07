'use client';

import { useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface ApiKeyFieldProps {
  label: string;
  settingKey: string;
  maskedValue: string | null;
  service: 'inworld' | 'anthropic' | 'readwise' | 'mistral';
  onSave: (key: string, value: string) => void;
  onTest: (
    service: 'inworld' | 'anthropic' | 'readwise' | 'mistral',
    apiKey: string,
  ) => Promise<{ success: boolean; message: string }>;
}

/**
 * Reusable API key input with test connection button.
 * Never reveals the stored key — only shows a masked placeholder.
 */
export function ApiKeyField({
  label,
  settingKey,
  maskedValue,
  service,
  onSave,
  onTest,
}: ApiKeyFieldProps) {
  const [value, setValue] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [testMessage, setTestMessage] = useState('');

  const hasStoredKey = maskedValue !== null;
  const placeholder = hasStoredKey ? maskedValue : 'Enter API key...';

  async function handleTest() {
    const keyToTest = value || '';
    if (!keyToTest) return;

    setTestStatus('testing');
    setTestMessage('');
    try {
      const result = await onTest(service, keyToTest);
      setTestStatus(result.success ? 'success' : 'error');
      setTestMessage(result.message);
    } catch {
      setTestStatus('error');
      setTestMessage('Failed to test connection');
    }
  }

  function handleSave() {
    if (value) {
      onSave(settingKey, value);
      setValue('');
    }
  }

  return (
    <div className="space-y-2">
      <label className="text-sm font-medium">{label}</label>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder={placeholder}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setTestStatus('idle');
            setTestMessage('');
          }}
          className="flex-1 font-mono"
          data-testid={`setting-${settingKey}`}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleTest}
          disabled={!value || testStatus === 'testing'}
        >
          {testStatus === 'testing' ? 'Testing...' : 'Test'}
        </Button>
        <Button type="button" size="sm" onClick={handleSave} disabled={!value}>
          Save
        </Button>
      </div>
      {testStatus === 'success' && <p className="text-success text-sm">{testMessage}</p>}
      {testStatus === 'error' && <p className="text-destructive text-sm">{testMessage}</p>}
      {hasStoredKey && !value && (
        <p className="text-muted-foreground text-xs">
          Key is saved. Enter a new value to replace it.
        </p>
      )}
    </div>
  );
}
