import { beforeAll, afterEach, afterAll } from 'vitest';
import { server } from './server';
import {
  assertNoInactiveModelRequests,
  installAnthropicModelTripwire,
} from './anthropic-model-tripwire';

// Global network tripwire (vitest setupFiles): see server.ts for the contract.
beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));

// Global model tripwire: any POST https://api.anthropic.com/v1/messages whose
// `model` is not in ACTIVE_MODEL_IDS fails the test that sent it. Most handlers
// ignore the request model, which once let a retired id pass the whole suite
// and break production AI. Body reads are async, so the check runs here (before
// the handler reset) once they settle; a deliberate non-registry model needs an
// explicit, commented drainModelViolations() in that test.
installAnthropicModelTripwire(server);

afterEach(async () => {
  try {
    await assertNoInactiveModelRequests();
  } finally {
    server.resetHandlers();
  }
});

// Catches requests sent after the last test's afterEach (e.g. from afterAll hooks).
afterAll(async () => {
  try {
    await assertNoInactiveModelRequests();
  } finally {
    server.close();
  }
});
