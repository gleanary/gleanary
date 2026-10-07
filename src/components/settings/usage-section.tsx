'use client';

import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

interface SummaryData {
  totalUsd: number;
  callCount: number;
  budgetUsd: number | null;
}

interface BreakdownEntry {
  key: string;
  totalUsd: number;
  callCount: number;
}

interface TopCall {
  id: number;
  feature: string;
  model: string;
  status: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  createdAt: string;
  runId?: string | null;
}

interface RunGroup {
  runId: string;
  feature: string;
  chunkCount: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  mistralChunks: number;
  haikuChunks: number;
  createdAt: string;
}

type DisplayRow = ({ kind: 'call' } & TopCall) | ({ kind: 'run' } & RunGroup);

function groupByRunId(calls: TopCall[]): DisplayRow[] {
  const runBuckets = new Map<string, TopCall[]>();
  const singles: TopCall[] = [];

  for (const c of calls) {
    if (c.runId) {
      if (!runBuckets.has(c.runId)) runBuckets.set(c.runId, []);
      runBuckets.get(c.runId)!.push(c);
    } else {
      singles.push(c);
    }
  }

  const rows: DisplayRow[] = singles.map((c) => ({ kind: 'call', ...c }));

  for (const [runId, chunks] of runBuckets) {
    let costUsd = 0,
      inputTokens = 0,
      outputTokens = 0,
      mistralChunks = 0,
      haikuChunks = 0;
    let createdAt = chunks[0]!.createdAt;
    for (const c of chunks) {
      costUsd += c.costUsd;
      inputTokens += c.inputTokens;
      outputTokens += c.outputTokens;
      if (c.model.includes('mistral')) mistralChunks++;
      if (c.model.includes('haiku')) haikuChunks++;
      if (c.createdAt < createdAt) createdAt = c.createdAt;
    }
    rows.push({
      kind: 'run',
      runId,
      feature: chunks[0]!.feature,
      chunkCount: chunks.length,
      costUsd,
      inputTokens,
      outputTokens,
      mistralChunks,
      haikuChunks,
      createdAt,
    });
  }

  return rows.sort((a, b) => b.costUsd - a.costUsd);
}

function UsageMetaCells({
  inputTokens,
  outputTokens,
  costUsd,
  createdAt,
}: {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: string;
}) {
  return (
    <>
      <td className="text-muted-foreground py-1.5 pr-3 text-right text-xs">
        {inputTokens.toLocaleString()}
      </td>
      <td className="text-muted-foreground py-1.5 pr-3 text-right text-xs">
        {outputTokens.toLocaleString()}
      </td>
      <td className="py-1.5 pr-3 text-right">${costUsd.toFixed(4)}</td>
      <td className="text-muted-foreground py-1.5 text-xs whitespace-nowrap">
        {new Date(createdAt + 'Z').toLocaleString()}
      </td>
    </>
  );
}

/**
 * Settings → Usage tab: monthly spend summary, budget input,
 * by-feature and by-model breakdowns, and top-calls table.
 */
export function UsageSection() {
  const [range, setRange] = useState<'day' | 'week' | 'month' | 'all'>('month');
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [byFeature, setByFeature] = useState<BreakdownEntry[]>([]);
  const [byModel, setByModel] = useState<BreakdownEntry[]>([]);
  const [topCalls, setTopCalls] = useState<DisplayRow[]>([]);
  const [budgetInput, setBudgetInput] = useState('');
  const [budgetSaving, setBudgetSaving] = useState(false);

  async function fetchAll(r: string) {
    const [sumRes, featRes, modelRes, topRes] = await Promise.all([
      fetch(`/api/usage/summary?range=${r}`),
      fetch(`/api/usage/breakdown?range=${r}&groupBy=feature`),
      fetch(`/api/usage/breakdown?range=${r}&groupBy=model`),
      fetch(`/api/usage/top-calls?range=${r}&limit=20`),
    ]);
    if (sumRes.ok) {
      const d: SummaryData = await sumRes.json();
      setSummary(d);
      setBudgetInput(d.budgetUsd !== null ? String(d.budgetUsd) : '');
    }
    if (featRes.ok) setByFeature((await featRes.json()).breakdown);
    if (modelRes.ok) setByModel((await modelRes.json()).breakdown);
    if (topRes.ok) setTopCalls(groupByRunId((await topRes.json()).calls));
  }

  useEffect(() => {
    fetchAll(range);
  }, [range]);

  async function saveBudget() {
    const parsed = parseFloat(budgetInput);
    const budgetUsd = budgetInput === '' ? null : isNaN(parsed) || parsed < 0 ? null : parsed;
    setBudgetSaving(true);
    try {
      await fetch('/api/usage/budget', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ budgetUsd }),
      });
      await fetchAll(range);
    } finally {
      setBudgetSaving(false);
    }
  }

  const RANGES = [
    { value: 'day', label: 'Today' },
    { value: 'week', label: '7 days' },
    { value: 'month', label: '30 days' },
    { value: 'all', label: 'All time' },
  ] as const;

  return (
    <div className="space-y-8">
      {/* Header card */}
      <div className="rounded-lg border p-4">
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-lg font-semibold">AI Usage</h2>
          <div className="flex gap-1">
            {RANGES.map((r) => (
              <Button
                key={r.value}
                variant={range === r.value ? 'default' : 'secondary'}
                size="xs"
                onClick={() => setRange(r.value)}
                className={range === r.value ? undefined : 'text-muted-foreground'}
              >
                {r.label}
              </Button>
            ))}
          </div>
        </div>
        {summary && (
          <div className="flex items-baseline gap-6">
            <div>
              <p className="text-muted-foreground text-xs">Total spend</p>
              <p className="text-2xl font-bold">${summary.totalUsd.toFixed(4)}</p>
            </div>
            <div>
              <p className="text-muted-foreground text-xs">API calls</p>
              <p className="text-2xl font-bold">{summary.callCount}</p>
            </div>
            {summary.budgetUsd !== null && (
              <div>
                <p className="text-muted-foreground text-xs">Monthly budget</p>
                <p
                  className={`text-2xl font-bold ${summary.totalUsd > summary.budgetUsd ? 'text-warning' : ''}`}
                >
                  ${summary.budgetUsd.toFixed(2)}
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Budget input */}
      <div>
        <h3 className="mb-2 text-sm font-semibold">Monthly budget (USD)</h3>
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="No budget set"
            value={budgetInput}
            onChange={(e) => setBudgetInput(e.target.value)}
            className="w-40"
          />
          <Button size="sm" onClick={saveBudget} disabled={budgetSaving}>
            {budgetSaving ? 'Saving…' : 'Save'}
          </Button>
          {budgetInput !== '' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setBudgetInput('');
              }}
              className="text-muted-foreground hover:text-foreground hover:bg-transparent dark:hover:bg-transparent"
            >
              Clear
            </Button>
          )}
        </div>
        <p className="text-muted-foreground mt-1 text-xs">
          Leave blank to remove the budget limit.
        </p>
      </div>

      {/* By-feature breakdown */}
      {byFeature.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">By feature</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left">
                <th className="pb-1 font-medium">Feature</th>
                <th className="pb-1 text-right font-medium">Calls</th>
                <th className="pb-1 text-right font-medium">Cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              {byFeature.map((row) => (
                <tr key={row.key} className="border-b last:border-0">
                  <td className="py-1.5 font-mono text-xs">{row.key}</td>
                  <td className="text-muted-foreground py-1.5 text-right">{row.callCount}</td>
                  <td className="py-1.5 text-right">${row.totalUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* By-model breakdown */}
      {byModel.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">By model</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-muted-foreground border-b text-left">
                <th className="pb-1 font-medium">Model</th>
                <th className="pb-1 text-right font-medium">Calls</th>
                <th className="pb-1 text-right font-medium">Cost (USD)</th>
              </tr>
            </thead>
            <tbody>
              {byModel.map((row) => (
                <tr key={row.key} className="border-b last:border-0">
                  <td className="py-1.5 font-mono text-xs">{row.key}</td>
                  <td className="text-muted-foreground py-1.5 text-right">{row.callCount}</td>
                  <td className="py-1.5 text-right">${row.totalUsd.toFixed(4)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Top calls */}
      {topCalls.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Most expensive calls</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-muted-foreground border-b text-left">
                  <th className="pr-3 pb-1 font-medium">Feature</th>
                  <th className="pr-3 pb-1 font-medium">Model</th>
                  <th className="pr-3 pb-1 text-right font-medium">In</th>
                  <th className="pr-3 pb-1 text-right font-medium">Out</th>
                  <th className="pr-3 pb-1 text-right font-medium">Cost</th>
                  <th className="pb-1 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {topCalls.map((row) =>
                  row.kind === 'run' ? (
                    <tr key={row.runId} className="border-b last:border-0">
                      <td className="py-1.5 pr-3 font-mono text-xs">
                        {row.feature}
                        <span className="text-muted-foreground ml-1">×{row.chunkCount} chunks</span>
                      </td>
                      <td className="text-muted-foreground py-1.5 pr-3 font-mono text-xs">
                        {[
                          row.mistralChunks > 0 && `mistral×${row.mistralChunks}`,
                          row.haikuChunks > 0 && `haiku×${row.haikuChunks}`,
                        ]
                          .filter(Boolean)
                          .join(' + ')}
                      </td>
                      <UsageMetaCells {...row} />
                    </tr>
                  ) : (
                    <tr key={row.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-3 font-mono text-xs">{row.feature}</td>
                      <td className="text-muted-foreground py-1.5 pr-3 font-mono text-xs">
                        {row.model.replace('claude-', '')}
                      </td>
                      <UsageMetaCells {...row} />
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {summary && summary.callCount === 0 && (
        <p className="text-muted-foreground text-sm">
          No AI calls recorded yet for this period. Make a chat message, summarize an article, or
          generate a draft to see usage here.
        </p>
      )}
    </div>
  );
}
