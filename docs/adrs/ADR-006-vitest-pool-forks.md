# ADR-006: Vitest Worker Pool Set to `forks`

**Date**: 2026-04
**Status**: Accepted

## Context

The test suite uses Vitest with the default `threads` pool (worker threads). After adding the voice extraction test (`voice-extraction.test.ts`), running that file in isolation caused Vitest to hang indefinitely on startup — the worker thread never initialized. The same hang was observed intermittently in `feed-poller.test.ts`.

Root cause: the Claude Anthropic SDK (used by voice extraction tests) and some Node.js modules imported by the feed poller (e.g. `node-cron`) have initialization paths that interact poorly with worker thread semantics — specifically, the way `worker_threads` shares memory and handles `require()` side effects at startup.

## Decision

Switch the Vitest pool from `threads` (default) to `forks` in `vitest.config.ts`.

## Rationale

1. **`forks` uses child processes instead of worker threads**: each test file runs in a true subprocess with its own Node.js instance, avoiding shared memory and module initialization ordering issues that cause hangs.

2. **No test logic changes required**: the fix is a one-line config change. All existing tests continue to pass without modification.

3. **Performance tradeoff is acceptable**: `forks` has higher per-test startup overhead than `threads` (~50–100ms per worker), but the test suite is small and the hang risk is worse than the marginal slowdown.

4. **`vmForks` was not chosen**: `vmForks` adds ES module isolation on top of forks. The extra isolation was not needed and adds complexity.

## Consequences

- `vitest.config.ts` has `pool: 'forks'` set explicitly.
- Tests run in child processes rather than worker threads.
- Slight increase in test startup time (not measurable in practice at current suite size).
- Any future test file that imports SDK modules with problematic thread initialization will work correctly without additional config.
