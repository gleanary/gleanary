# SESSION: e2e-tests

**Trigger**: "Write E2E tests" or "Add E2E for `<journey>`"

Playwright tests for critical user journeys.

## Workflow

1. **READ** — Review `docs/architecture.md` Section 11.5 for the critical paths list
2. **WRITE** — Create Playwright tests in `e2e/`
3. **RUN** — `npx playwright test` to verify they pass
4. **DOCUMENT** — If a new critical journey was added, update the list in `docs/architecture.md` §11.5 (requires human approval)
