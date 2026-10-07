import type { Suggestion } from '@/lib/lint/types';

/** Drains an async generator into a flat array so suggestions can be asserted. */
export async function collect(gen: AsyncGenerator<Suggestion>): Promise<Suggestion[]> {
  const out: Suggestion[] = [];
  for await (const s of gen) out.push(s);
  return out;
}
