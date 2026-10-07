import { beforeAll, afterEach, afterAll } from 'vitest';
import { server } from './server';

// Global network tripwire (vitest setupFiles): see server.ts for the contract.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
