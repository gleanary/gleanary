'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { LogOut } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { ApiKeyField } from '@/components/settings/api-key-field';
import { PasswordConfirmDialog } from '@/components/settings/password-confirm-dialog';
import { SettingsSidebar, type SettingsSection } from '@/components/settings/settings-sidebar';
import { VoiceSection } from '@/components/settings/voice-section';
import { UsageSection } from '@/components/settings/usage-section';
import type { AuditLogEntry, AppearanceMode } from '@/types';
import type { ReadwiseImportProgress, ReadwiseImportStats } from '@/lib/readwise-import';

interface SettingEntry {
  value: string | null;
  isEncrypted: boolean;
  section: string;
}

interface SettingsResponse {
  settings: Record<string, SettingEntry>;
  encryptionAvailable: boolean;
  authActive: boolean;
}

type PendingAction =
  | { type: 'save'; key: string; value: string }
  | {
      type: 'test';
      service: 'inworld' | 'anthropic' | 'readwise' | 'mistral';
      apiKey: string;
      resolve: (result: { success: boolean; message: string }) => void;
    };

/**
 * Main settings page client component with collapsible sections,
 * API key management, and audit log.
 */
export function SettingsPage() {
  const searchParams = useSearchParams();
  const [activeSection, setActiveSection] = useState<SettingsSection>('general');
  const [settings, setSettings] = useState<Record<string, SettingEntry>>({});
  const [encryptionAvailable, setEncryptionAvailable] = useState(true);
  const [authActive, setAuthActive] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Password confirm dialog state
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordLoading, setPasswordLoading] = useState(false);
  const pendingAction = useRef<PendingAction | null>(null);

  // Collapsed sections
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Readwise import state
  const [importState, setImportState] = useState<'idle' | 'running' | 'complete' | 'error'>('idle');
  const [importProgress, setImportProgress] = useState<ReadwiseImportProgress | null>(null);
  const [importStats, setImportStats] = useState<ReadwiseImportStats | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Appearance mode — kept in sync with localStorage for instant theme switching
  const [appearanceMode, setAppearanceMode] = useState<AppearanceMode>('automatic');

  // IMAP test and poll state
  const [imapTestStatus, setImapTestStatus] = useState<'idle' | 'testing' | 'success' | 'error'>(
    'idle',
  );
  const [imapTestResult, setImapTestResult] = useState<{
    mailboxes?: string[];
    error?: string;
  } | null>(null);
  const [imapPollStatus, setImapPollStatus] = useState<'idle' | 'polling' | 'done' | 'error'>(
    'idle',
  );
  const [imapPollResult, setImapPollResult] = useState<string | null>(null);

  const fetchSettings = useCallback(async () => {
    const resp = await fetch('/api/settings');
    if (resp.ok) {
      const data: SettingsResponse = await resp.json();
      setSettings(data.settings);
      setEncryptionAvailable(data.encryptionAvailable);
      setAuthActive(data.authActive);
    }
    setLoading(false);
  }, []);

  const fetchAudit = useCallback(async () => {
    const resp = await fetch('/api/settings/audit?limit=50');
    if (resp.ok) {
      const data = await resp.json();
      setAuditEntries(data.entries);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
    fetchAudit();
    // Initialise appearance from localStorage on mount
    const stored = localStorage.getItem('appearance_mode') as AppearanceMode | null;
    if (stored === 'dark' || stored === 'light' || stored === 'automatic') {
      setAppearanceMode(stored);
    }
    // ?tab= URL param takes priority; fall back to localStorage
    const tabParam = searchParams.get('tab') as SettingsSection | null;
    if (
      tabParam === 'general' ||
      tabParam === 'integrations' ||
      tabParam === 'voice' ||
      tabParam === 'usage'
    ) {
      setActiveSection(tabParam);
    } else {
      const storedSection = localStorage.getItem('settingsSection') as SettingsSection | null;
      if (
        storedSection === 'general' ||
        storedSection === 'integrations' ||
        storedSection === 'voice' ||
        storedSection === 'usage'
      ) {
        setActiveSection(storedSection);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSectionChange(section: SettingsSection) {
    setActiveSection(section);
    localStorage.setItem('settingsSection', section);
  }

  // Debounced save for non-encrypted settings
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Clean up debounce timers on unmount
  useEffect(() => {
    const timers = debounceTimers.current;
    return () => {
      for (const timer of Object.values(timers)) {
        clearTimeout(timer);
      }
    };
  }, []);

  function handleNonSecretChange(key: string, value: string) {
    setSettings((prev) => ({
      ...prev,
      [key]: { ...prev[key]!, value, isEncrypted: false, section: prev[key]?.section ?? '' },
    }));

    clearTimeout(debounceTimers.current[key]);
    debounceTimers.current[key] = setTimeout(async () => {
      const resp = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: { [key]: value } }),
      });
      if (!resp.ok) {
        // Revert local state on failure
        fetchSettings();
      }
      fetchAudit();
    }, 500);
  }

  /**
   * Handles appearance mode change: applies class immediately to avoid flicker,
   * persists to localStorage for FOUC prevention on next load, and saves to API.
   */
  function handleAppearanceChange(mode: AppearanceMode) {
    setAppearanceMode(mode);
    localStorage.setItem('appearance_mode', mode);
    const root = document.documentElement;
    if (mode === 'dark') {
      root.classList.add('dark');
    } else if (mode === 'light') {
      root.classList.remove('dark');
    } else {
      // automatic: follow system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.classList.toggle('dark', prefersDark);
    }
    handleNonSecretChange('appearance_mode', mode);
  }

  /**
   * Ends the current session via POST /api/auth/logout, then hard-navigates to
   * /login (full reload so all client state is dropped with the session).
   */
  async function handleSignOut() {
    setSigningOut(true);
    setSignOutError(null);
    try {
      const res = await fetch('/api/auth/logout', { method: 'POST' });
      if (res.ok) {
        window.location.assign('/login');
        return;
      }
      setSignOutError('Sign out failed — try again');
    } catch {
      setSignOutError('Network error — check your connection');
    }
    setSigningOut(false);
  }

  // Encrypted setting save — triggers password dialog
  function handleEncryptedSave(key: string, value: string) {
    pendingAction.current = { type: 'save', key, value };
    setPasswordError(null);
    setPasswordDialogOpen(true);
  }

  // Test API key — triggers password dialog
  function handleTestKey(
    service: 'inworld' | 'anthropic' | 'readwise' | 'mistral',
    apiKey: string,
  ): Promise<{ success: boolean; message: string }> {
    return new Promise((resolve) => {
      pendingAction.current = { type: 'test', service, apiKey, resolve };
      setPasswordError(null);
      setPasswordDialogOpen(true);
    });
  }

  async function handlePasswordConfirm(password: string) {
    const action = pendingAction.current;
    if (!action) return;

    setPasswordLoading(true);
    setPasswordError(null);

    try {
      if (action.type === 'save') {
        const resp = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            settings: { [action.key]: action.value },
            confirm_password: password,
          }),
        });

        if (resp.ok) {
          setPasswordDialogOpen(false);
          pendingAction.current = null;
          fetchSettings();
          fetchAudit();
        } else {
          const err = await resp.json();
          setPasswordError(err.error ?? 'Failed to save');
        }
      } else if (action.type === 'test') {
        const resp = await fetch('/api/settings/test', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            service: action.service,
            api_key: action.apiKey,
            confirm_password: password,
          }),
        });
        const data = await resp.json();
        setPasswordDialogOpen(false);
        pendingAction.current = null;
        fetchAudit();

        if (resp.ok) {
          action.resolve(data);
        } else {
          action.resolve({ success: false, message: data.error ?? 'Test failed' });
        }
      }
    } finally {
      setPasswordLoading(false);
    }
  }

  function handlePasswordCancel() {
    setPasswordDialogOpen(false);
    const action = pendingAction.current;
    if (action?.type === 'test') {
      action.resolve({ success: false, message: 'Cancelled' });
    }
    pendingAction.current = null;
  }

  async function handleReadwiseImport(mode: 'full' | 'incremental') {
    setImportState('running');
    setImportProgress(null);
    setImportStats(null);
    setImportError(null);

    try {
      const resp = await fetch(`/api/import/readwise?mode=${mode}`, { method: 'POST' });

      if (!resp.ok || !resp.body) {
        const err = await resp.json().catch(() => ({ error: 'Import failed' }));
        setImportError(err.error ?? 'Import failed');
        setImportState('error');
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventName = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventName = line.slice(7).trim();
          } else if (line.startsWith('data: ') && eventName) {
            const data = JSON.parse(line.slice(6));
            if (eventName === 'progress') {
              setImportProgress(data as ReadwiseImportProgress);
            } else if (eventName === 'complete') {
              setImportStats(data as ReadwiseImportStats);
              setImportState('complete');
              fetchSettings(); // refresh readwise_last_import
            } else if (eventName === 'error') {
              setImportError(data.message ?? 'Import failed');
              setImportState('error');
            }
            eventName = '';
          }
        }
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed');
      setImportState('error');
    }
  }

  function toggleSection(section: string) {
    setCollapsed((prev) => ({ ...prev, [section]: !prev[section] }));
  }

  const hasAnthropicKey = settings.anthropic_api_key?.value !== null;

  if (loading) {
    return <div className="text-muted-foreground py-8 text-center">Loading settings...</div>;
  }

  const sections = [
    {
      id: 'appearance',
      title: 'Appearance',
      content: (
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">Choose how Reader looks to you.</p>
          <div className="flex gap-2" role="radiogroup" aria-label="Appearance mode">
            {(['automatic', 'light', 'dark'] as const).map((mode) => (
              // Accepted raw <button> (handover §5): ARIA radiogroup option (role="radio" +
              // aria-checked). Kept raw to preserve radio semantics, mirroring the role="tab"
              // exception in search-page-content.
              <button
                key={mode}
                role="radio"
                aria-checked={appearanceMode === mode}
                onClick={() => handleAppearanceChange(mode)}
                data-testid={`appearance-mode-${mode}`}
                className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                  appearanceMode === mode
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                {mode === 'automatic' && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
                  </svg>
                )}
                {mode === 'light' && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="5" />
                    <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                  </svg>
                )}
                {mode === 'dark' && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
                  </svg>
                )}
                {mode.charAt(0).toUpperCase() + mode.slice(1)}
              </button>
            ))}
          </div>
        </div>
      ),
    },
    {
      id: 'ai',
      title: 'AI Services',
      content: (
        <div className="space-y-6">
          <ApiKeyField
            label="Anthropic API Key"
            settingKey="anthropic_api_key"
            maskedValue={settings.anthropic_api_key?.value ?? null}
            service="anthropic"
            onSave={handleEncryptedSave}
            onTest={handleTestKey}
          />
          <ApiKeyField
            label="Mistral API Key"
            settingKey="mistral_api_key"
            maskedValue={settings.mistral_api_key?.value ?? null}
            service="mistral"
            onSave={handleEncryptedSave}
            onTest={handleTestKey}
          />
          <ApiKeyField
            label="Inworld TTS API Key"
            settingKey="inworld_api_key"
            maskedValue={settings.inworld_api_key?.value ?? null}
            service="inworld"
            onSave={handleEncryptedSave}
            onTest={handleTestKey}
          />
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Default English Voice</label>
              <Input
                value={settings.inworld_voice_en?.value ?? ''}
                onChange={(e) => handleNonSecretChange('inworld_voice_en', e.target.value)}
                placeholder="Dennis"
                data-testid="setting-inworld_voice_en"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Default French Voice</label>
              <Input
                value={settings.inworld_voice_fr?.value ?? ''}
                onChange={(e) => handleNonSecretChange('inworld_voice_fr', e.target.value)}
                placeholder="Marie"
                data-testid="setting-inworld_voice_fr"
              />
            </div>
          </div>
        </div>
      ),
    },
    {
      id: 'readwise',
      title: 'Readwise Import',
      content: (() => {
        const lastImport = settings.readwise_last_import?.value;
        const hasToken = settings.readwise_api_token?.value !== null;
        const isRunning = importState === 'running';

        const progressLabel = (() => {
          if (!importProgress) return null;
          if (importProgress.phase === 'fetching') {
            return `Fetching page ${importProgress.page}...`;
          }
          if (importProgress.phase === 'importing') {
            return `Importing ${importProgress.current} of ${importProgress.total} articles (${importProgress.highlights} highlights)...`;
          }
          return null;
        })();

        const progressPct = importProgress?.total
          ? Math.round(((importProgress.current ?? 0) / importProgress.total) * 100)
          : null;

        return (
          <div className="space-y-4">
            <ApiKeyField
              label="Readwise API Token"
              settingKey="readwise_api_token"
              maskedValue={settings.readwise_api_token?.value ?? null}
              service="readwise"
              onSave={handleEncryptedSave}
              onTest={handleTestKey}
            />

            {hasToken && (
              <div className="space-y-3">
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleReadwiseImport('full')}
                    disabled={isRunning}
                    data-testid="readwise-import-full"
                    className="disabled:cursor-not-allowed"
                  >
                    {isRunning && importProgress?.phase === 'importing'
                      ? 'Importing...'
                      : 'Import from Readwise'}
                  </Button>
                  {lastImport && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleReadwiseImport('incremental')}
                      disabled={isRunning}
                      data-testid="readwise-import-incremental"
                      className="disabled:cursor-not-allowed"
                    >
                      Sync new
                    </Button>
                  )}
                </div>

                {isRunning && (
                  <div className="space-y-1">
                    {progressLabel && (
                      <p className="text-muted-foreground text-sm">{progressLabel}</p>
                    )}
                    {progressPct !== null && (
                      <div className="bg-muted h-2 w-full overflow-hidden rounded-full">
                        <div
                          className="bg-primary h-full rounded-full transition-all"
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}

                {importState === 'complete' && importStats && (
                  <p className="text-success text-sm">
                    Done: {importStats.articles} articles, {importStats.highlights} highlights
                    imported
                    {importStats.skippedNonArticles > 0
                      ? ` (${importStats.skippedNonArticles} non-articles skipped)`
                      : ''}
                    .
                  </p>
                )}

                {importState === 'error' && importError && (
                  <p className="text-destructive text-sm">{importError}</p>
                )}

                {lastImport && importState === 'idle' && (
                  <p className="text-muted-foreground text-xs">
                    Last synced: {new Date(lastImport).toLocaleString()}
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })(),
    },
    {
      id: 'reading',
      title: 'Reading',
      content: (
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">TTS Playback Speed</label>
            <Input
              type="number"
              min={0.5}
              max={1.5}
              step={0.1}
              value={settings.tts_default_speed?.value ?? '1.0'}
              onChange={(e) => handleNonSecretChange('tts_default_speed', e.target.value)}
              data-testid="setting-tts_default_speed"
            />
            <p className="text-muted-foreground text-xs">0.5 to 1.5</p>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">Daily Review Batch Size</label>
            <Input
              type="number"
              min={5}
              max={50}
              step={1}
              value={settings.daily_review_batch_size?.value ?? '15'}
              onChange={(e) => handleNonSecretChange('daily_review_batch_size', e.target.value)}
              data-testid="setting-daily_review_batch_size"
            />
            <p className="text-muted-foreground text-xs">5 to 50 highlights per session</p>
          </div>
        </div>
      ),
    },
    {
      id: 'feeds',
      title: 'Feeds',
      content: (
        <div className="max-w-xs space-y-2">
          <label className="text-sm font-medium">RSS Poll Interval (minutes)</label>
          <Input
            type="number"
            min={5}
            max={1440}
            step={5}
            value={settings.rss_poll_interval?.value ?? '30'}
            onChange={(e) => handleNonSecretChange('rss_poll_interval', e.target.value)}
            data-testid="setting-rss_poll_interval"
          />
          <p className="text-muted-foreground text-xs">5 to 1440 minutes (24 hours)</p>
        </div>
      ),
    },
    {
      id: 'newsletter',
      title: 'Newsletter (IMAP)',
      content: (() => {
        const host = settings.imap_host?.value ?? '';
        const hasUser = settings.imap_user?.value !== null;
        const hasPassword = settings.imap_password?.value !== null;
        const isIncomplete = host && (!hasUser || !hasPassword);

        async function handleImapTest() {
          setImapTestStatus('testing');
          setImapTestResult(null);
          try {
            const resp = await fetch('/api/settings/test-imap', { method: 'POST' });
            const data = await resp.json();
            if (data.success) {
              setImapTestStatus('success');
              setImapTestResult({ mailboxes: data.mailboxes });
            } else {
              setImapTestStatus('error');
              setImapTestResult({ error: data.error });
            }
          } catch {
            setImapTestStatus('error');
            setImapTestResult({ error: 'Request failed' });
          }
        }

        async function handleImapPoll() {
          setImapPollStatus('polling');
          setImapPollResult(null);
          try {
            const resp = await fetch('/api/newsletters/poll', { method: 'POST' });
            const data = await resp.json();
            if (resp.ok) {
              if (data.errors?.length) {
                setImapPollStatus('error');
                setImapPollResult(data.errors.join('; '));
              } else {
                setImapPollStatus('done');
                setImapPollResult(`${data.newArticles} new article(s)`);
              }
            } else {
              setImapPollStatus('error');
              setImapPollResult(data.error ?? 'Poll failed');
            }
          } catch {
            setImapPollStatus('error');
            setImapPollResult('Request failed');
          }
        }

        return (
          <div className="space-y-4">
            {isIncomplete && (
              <div className="border-tint-amber-fg/30 bg-tint-amber text-tint-amber-fg rounded-md border px-4 py-3 text-sm">
                IMAP configuration is incomplete. Polling is disabled until host, username, and
                password are all set.
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">IMAP Host</label>
                <Input
                  value={host}
                  onChange={(e) => handleNonSecretChange('imap_host', e.target.value)}
                  placeholder="imap.gmail.com"
                  data-testid="setting-imap_host"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Port</label>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={settings.imap_port?.value ?? '993'}
                  onChange={(e) => handleNonSecretChange('imap_port', e.target.value)}
                  data-testid="setting-imap_port"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Username</label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder={
                    hasUser ? (settings.imap_user?.value ?? '••••••••') : 'Enter username...'
                  }
                  className="flex-1 font-mono"
                  data-testid="setting-imap_user"
                  onBlur={(e) => {
                    if (e.target.value) handleEncryptedSave('imap_user', e.target.value);
                  }}
                />
              </div>
              {hasUser && (
                <p className="text-muted-foreground text-xs">
                  Username is saved. Enter a new value to replace it.
                </p>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Password</label>
              <div className="flex gap-2">
                <Input
                  type="password"
                  placeholder={
                    hasPassword
                      ? (settings.imap_password?.value ?? '••••••••')
                      : 'Enter password...'
                  }
                  className="flex-1 font-mono"
                  data-testid="setting-imap_password"
                  onBlur={(e) => {
                    if (e.target.value) handleEncryptedSave('imap_password', e.target.value);
                  }}
                />
              </div>
              {hasPassword && (
                <p className="text-muted-foreground text-xs">
                  Password is saved. Enter a new value to replace it.
                </p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <label className="text-sm font-medium">Mailbox</label>
                <Input
                  value={settings.imap_mailbox?.value ?? 'INBOX'}
                  onChange={(e) => handleNonSecretChange('imap_mailbox', e.target.value)}
                  placeholder="INBOX"
                  data-testid="setting-imap_mailbox"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Poll Interval (minutes)</label>
                <Input
                  type="number"
                  min={1}
                  max={1440}
                  value={settings.imap_poll_interval?.value ?? '5'}
                  onChange={(e) => handleNonSecretChange('imap_poll_interval', e.target.value)}
                  data-testid="setting-imap_poll_interval"
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="imap_tls"
                checked={(settings.imap_tls?.value ?? 'true') !== 'false'}
                onChange={(e) =>
                  handleNonSecretChange('imap_tls', e.target.checked ? 'true' : 'false')
                }
                data-testid="setting-imap_tls"
                className="h-4 w-4 rounded border"
              />
              <label htmlFor="imap_tls" className="text-sm font-medium">
                Use TLS
              </label>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleImapTest}
                disabled={imapTestStatus === 'testing'}
                data-testid="imap-test-connection"
                className="disabled:cursor-not-allowed"
              >
                {imapTestStatus === 'testing' ? 'Connecting...' : 'Test Connection'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleImapPoll}
                disabled={imapPollStatus === 'polling'}
                data-testid="imap-poll-now"
                className="disabled:cursor-not-allowed"
              >
                {imapPollStatus === 'polling' ? 'Polling...' : 'Poll Now'}
              </Button>
            </div>

            {imapTestStatus === 'success' && imapTestResult?.mailboxes && (
              <p className="text-success text-sm">
                Connected. Mailboxes: {imapTestResult.mailboxes.join(', ')}
              </p>
            )}
            {imapTestStatus === 'error' && imapTestResult?.error && (
              <p className="text-destructive text-sm">{imapTestResult.error}</p>
            )}
            {imapPollStatus === 'done' && imapPollResult && (
              <p className="text-success text-sm">{imapPollResult}</p>
            )}
            {imapPollStatus === 'error' && imapPollResult && (
              <p className="text-destructive text-sm">{imapPollResult}</p>
            )}
          </div>
        );
      })(),
    },
    {
      id: 'account',
      title: 'Account',
      content: (
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">
            Signing out ends the session on this device. Sessions on other devices stay active until
            they expire.
          </p>
          <Button
            variant="outline"
            onClick={handleSignOut}
            disabled={signingOut}
            data-testid="sign-out-button"
          >
            <LogOut size={16} />
            {signingOut ? 'Signing out...' : 'Sign out'}
          </Button>
          {signOutError && <p className="text-destructive text-sm">{signOutError}</p>}
        </div>
      ),
    },
  ];

  // Account only appears when auth is actually active (hidden for AUTH_DISABLED/VPN setups)
  const generalSectionIds = ['appearance', 'reading', ...(authActive ? ['account'] : [])];
  const integrationSectionIds = ['ai', 'readwise', 'feeds', 'newsletter'];

  const visibleSections = sections.filter((s) => {
    if (activeSection === 'general') return generalSectionIds.includes(s.id);
    if (activeSection === 'integrations') return integrationSectionIds.includes(s.id);
    return false;
  });

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      {!encryptionAvailable && (
        <div className="border-tint-amber-fg/30 bg-tint-amber text-tint-amber-fg rounded-md border px-4 py-3 text-sm">
          SETTINGS_ENCRYPTION_KEY is not set. Encrypted settings (API keys) cannot be saved.
          Generate one with: <code className="font-mono text-xs">openssl rand -hex 32</code>
        </div>
      )}

      <div className="flex flex-col gap-6 sm:flex-row">
        <SettingsSidebar active={activeSection} onSelect={handleSectionChange} />

        <div className="min-w-0 flex-1 space-y-6">
          {activeSection === 'voice' ? (
            <VoiceSection hasAnthropicKey={hasAnthropicKey} />
          ) : activeSection === 'usage' ? (
            <UsageSection />
          ) : (
            <>
              {visibleSections.map((section) => (
                <div key={section.id} className="space-y-3">
                  <Button
                    variant="ghost"
                    onClick={() => toggleSection(section.id)}
                    className="text-foreground/80 hover:text-foreground h-auto w-full justify-start gap-2 p-0 text-lg font-semibold hover:bg-transparent dark:hover:bg-transparent"
                  >
                    <span className="text-muted-foreground text-sm">
                      {collapsed[section.id] ? '▶' : '▼'}
                    </span>
                    {section.title}
                  </Button>
                  {!collapsed[section.id] && <div className="pl-5">{section.content}</div>}
                  <Separator />
                </div>
              ))}

              {/* Audit Log — shown under Integrations */}
              {activeSection === 'integrations' && (
                <div className="space-y-3">
                  <Button
                    variant="ghost"
                    onClick={() => toggleSection('audit')}
                    className="text-foreground/80 hover:text-foreground h-auto w-full justify-start gap-2 p-0 text-lg font-semibold hover:bg-transparent dark:hover:bg-transparent"
                  >
                    <span className="text-muted-foreground text-sm">
                      {collapsed.audit ? '▶' : '▼'}
                    </span>
                    Audit Log
                  </Button>
                  {!collapsed.audit && (
                    <div className="pl-5">
                      {auditEntries.length === 0 ? (
                        <p className="text-muted-foreground text-sm">No audit entries yet.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-muted-foreground border-b text-left">
                                <th className="pr-4 pb-2 font-medium">Time</th>
                                <th className="pr-4 pb-2 font-medium">Action</th>
                                <th className="pr-4 pb-2 font-medium">Setting</th>
                                <th className="pb-2 font-medium">IP</th>
                              </tr>
                            </thead>
                            <tbody>
                              {auditEntries.map((entry) => (
                                <tr key={entry.id} className="border-b last:border-0">
                                  <td className="text-muted-foreground py-1.5 pr-4 whitespace-nowrap">
                                    {new Date(entry.timestamp + 'Z').toLocaleString()}
                                  </td>
                                  <td className="py-1.5 pr-4">
                                    <span className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">
                                      {entry.action}
                                    </span>
                                  </td>
                                  <td className="py-1.5 pr-4 font-mono text-xs">{entry.key}</td>
                                  <td className="text-muted-foreground py-1.5 text-xs">
                                    {entry.ipAddress ?? '—'}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <PasswordConfirmDialog
        open={passwordDialogOpen}
        onConfirm={handlePasswordConfirm}
        onCancel={handlePasswordCancel}
        loading={passwordLoading}
        error={passwordError}
      />
    </div>
  );
}
