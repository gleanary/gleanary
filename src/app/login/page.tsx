'use client';

import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        const next = searchParams.get('next');
        // Only allow same-origin relative destinations (\ is treated as / by URL parsers)
        const safeNext =
          next && next.startsWith('/') && !next.startsWith('//') && !next.includes('\\')
            ? next
            : '/';
        router.push(safeNext);
        router.refresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      setError(body?.error ?? 'Login failed');
    } catch {
      setError('Network error — check your connection');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="bg-card border-border w-full max-w-sm rounded-lg border p-6">
        <h1 className="mb-1 text-lg font-semibold">Gleanary</h1>
        <p className="text-muted-foreground mb-6 text-sm">Enter your password to continue.</p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <Input
            data-testid="login-password-input"
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            required
          />
          <Button
            data-testid="login-submit-button"
            type="submit"
            className="w-full"
            disabled={submitting || !password}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        {error && (
          <p data-testid="login-error" className="text-destructive mt-4 text-sm">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
