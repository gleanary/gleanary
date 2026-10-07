/**
 * Runs an array of async thunks with a bounded number in flight at once,
 * preserving result ordering (result[i] corresponds to fns[i]).
 * @param fns - Array of zero-arg async functions to invoke
 * @param limit - Maximum number of thunks running concurrently
 * @returns Promise resolving to the results in the same order as `fns`
 */
export async function runWithConcurrency<T>(
  fns: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(fns.length);
  let next = 0;
  async function worker() {
    while (next < fns.length) {
      const i = next++;
      results[i] = await fns[i]!();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, fns.length) }, worker));
  return results;
}
