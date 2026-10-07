'use client';

import { useState, useEffect, useCallback, useRef, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { parseArticleByUrl } from '@/lib/article-api';
import Link from 'next/link';

type SaveStatus = 'idle' | 'saving' | 'saved' | 'duplicate' | 'error';

function SaveForm() {
  const searchParams = useSearchParams();
  const paramUrl = searchParams.get('url') ?? searchParams.get('text');
  const [urlInput, setUrlInput] = useState(paramUrl ?? '');
  const [status, setStatus] = useState<SaveStatus>('idle');
  const [savedArticleId, setSavedArticleId] = useState<number | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const hasAutoSubmitted = useRef(false);

  const save = useCallback(async (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    setStatus('saving');
    setSavedArticleId(null);
    setErrorMessage(null);
    try {
      const result = await parseArticleByUrl(trimmed);
      if (result.duplicate) {
        setSavedArticleId(result.existingId ?? null);
        setStatus('duplicate');
        return;
      }
      if (!result.ok) {
        setErrorMessage(result.error ?? 'Something went wrong');
        setStatus('error');
        return;
      }
      setSavedArticleId(result.article?.id ?? null);
      setStatus('saved');
    } catch {
      setErrorMessage('Network error — check your connection');
      setStatus('error');
    }
  }, []);

  // Auto-submit the form when ?url= query param is present (once only)
  useEffect(() => {
    if (paramUrl && !hasAutoSubmitted.current) {
      hasAutoSubmitted.current = true;
      formRef.current?.requestSubmit();
    }
  }, [paramUrl]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void save(urlInput);
  }

  function reset() {
    setUrlInput('');
    setStatus('idle');
    setSavedArticleId(null);
    setErrorMessage(null);
  }

  return (
    <main className="mx-auto w-full max-w-md px-4 py-8">
      <h1 className="mb-6 text-xl font-medium">Save article</h1>

      <form ref={formRef} onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Input
          data-testid="save-url-input"
          type="url"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          placeholder="https://example.com/article"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          disabled={status === 'saving'}
          required
        />
        <Button
          data-testid="save-submit-button"
          type="submit"
          size="lg"
          className="w-full"
          disabled={status === 'saving' || !urlInput.trim()}
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </Button>
      </form>

      {status !== 'idle' && (
        <div data-testid="save-status" className="mt-6">
          {status === 'saving' && <p className="text-muted-foreground">Saving article…</p>}

          {status === 'saved' && (
            <div className="flex flex-col gap-3">
              <p className="text-success">Saved!</p>
              {savedArticleId && (
                <Link
                  data-testid="save-open-link"
                  href={`/reader/${savedArticleId}`}
                  className="text-sm underline"
                >
                  Open in Gleanary
                </Link>
              )}
              <Button variant="outline" size="sm" onClick={reset}>
                Save another
              </Button>
            </div>
          )}

          {status === 'duplicate' && (
            <div className="flex flex-col gap-3">
              <p className="text-warning">Already in your library</p>
              {savedArticleId && (
                <Link
                  data-testid="save-duplicate-open-link"
                  href={`/reader/${savedArticleId}`}
                  className="text-sm underline"
                >
                  Open in Gleanary
                </Link>
              )}
              <Button variant="outline" size="sm" onClick={reset}>
                Save another
              </Button>
            </div>
          )}

          {status === 'error' && (
            <div className="flex flex-col gap-3">
              <p className="text-destructive">{errorMessage ?? 'Something went wrong'}</p>
              <Button variant="outline" size="sm" onClick={reset}>
                Try again
              </Button>
            </div>
          )}
        </div>
      )}
      <details className="mt-10 rounded-lg border p-4">
        <summary className="text-muted-foreground cursor-pointer text-sm font-medium">
          Save from iOS share sheet
        </summary>
        <div className="text-muted-foreground mt-3 space-y-3 text-sm">
          <p>Create an iOS Shortcut to save articles directly from Safari&apos;s share menu:</p>
          <ol className="list-inside list-decimal space-y-2">
            <li>
              Open the <strong>Shortcuts</strong> app on your iPhone/iPad
            </li>
            <li>
              Tap <strong>+</strong> to create a new Shortcut
            </li>
            <li>
              Add the <strong>Open URLs</strong> action
            </li>
            <li>
              Set the URL to your Gleanary&apos;s{' '}
              <code className="bg-muted rounded px-1.5 py-0.5 text-xs">/save?url=</code> followed by
              the <strong>Shortcut Input</strong> variable
            </li>
            <li>
              Tap the <strong>ⓘ</strong> button at the top → enable{' '}
              <strong>Show in Share Sheet</strong>
            </li>
            <li>
              Name it <strong>&quot;Save to Gleanary&quot;</strong>
            </li>
          </ol>
          <p className="text-xs">
            When you share a link from Safari, choose &quot;Save to Gleanary&quot; — it opens this
            page with the URL pre-filled and saves automatically.
          </p>

          <details className="mt-2">
            <summary className="cursor-pointer text-xs">
              Advanced: background save without opening browser
            </summary>
            <div className="mt-2 space-y-2 text-xs">
              <p>
                For a silent save (no browser redirect), use <strong>Get Contents of URL</strong>{' '}
                instead:
              </p>
              <ol className="list-inside list-decimal space-y-1">
                <li>
                  Add <strong>URL</strong> action → set to your Gleanary API URL:{' '}
                  <code className="bg-muted rounded px-1 py-0.5">/api/articles/parse</code>
                </li>
                <li>
                  Add <strong>Get Contents of URL</strong> action
                </li>
                <li>
                  Set Method to <strong>POST</strong>, Request Body to <strong>JSON</strong>
                </li>
                <li>
                  Add key <code className="bg-muted rounded px-1 py-0.5">url</code> with value set
                  to <strong>Shortcut Input</strong>
                </li>
                <li>
                  Under Headers, add{' '}
                  <code className="bg-muted rounded px-1 py-0.5">Authorization</code> with value{' '}
                  <code className="bg-muted rounded px-1 py-0.5">
                    Basic &lt;your-credentials&gt;
                  </code>
                </li>
                <li>
                  Add <strong>Show Notification</strong> to confirm the save
                </li>
              </ol>
              <p>This requires entering your Caddy basic auth credentials in the Shortcut.</p>
            </div>
          </details>
        </div>
      </details>

      <details className="mt-4 rounded-lg border p-4">
        <summary className="text-muted-foreground cursor-pointer text-sm font-medium">
          Install as app (Android)
        </summary>
        <div className="text-muted-foreground mt-3 space-y-2 text-sm">
          <p>Install Gleanary as an app on your Android device for share sheet integration:</p>
          <ol className="list-inside list-decimal space-y-1">
            <li>
              Open this site in <strong>Chrome</strong> on your Android device
            </li>
            <li>
              Tap the <strong>⋮</strong> menu → <strong>Install app</strong> (or &quot;Add to Home
              screen&quot;)
            </li>
            <li>Once installed, Gleanary appears in your share sheet</li>
          </ol>
          <p className="text-xs">
            When you share a URL from any app, choose &quot;Gleanary&quot; — it opens this save page
            automatically.
          </p>
        </div>
      </details>
    </main>
  );
}

export default function SavePage() {
  return (
    <Suspense>
      <SaveForm />
    </Suspense>
  );
}
