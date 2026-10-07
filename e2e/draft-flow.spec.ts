import { test, expect, type Page } from '@playwright/test';
import { waitForApiResponse } from './utils';

interface SeedData {
  articleId: number;
  highlightId: number;
  thesisId: number;
  researchId: number;
  sampleId: number;
}

const MOCK_DRAFT_HEADING = 'E2E Test Draft';

async function seedTestData(page: Page): Promise<SeedData> {
  const suffix = Date.now();

  // Batch 1: independent resources in parallel
  const [articleRes, thesisRes, sampleRes] = await Promise.all([
    page.request.post('/api/articles', {
      data: {
        url: `https://example.com/draft-e2e-${suffix}`,
        title: `E2E Draft Article ${suffix}`,
        contentHtml: '<p>Test content for draft E2E flow.</p>',
        contentText: 'Test content for draft E2E flow.',
      },
    }),
    page.request.post('/api/theses', {
      data: {
        title: `E2E Thesis ${suffix}`,
        claim: 'AI-generated drafts save significant writing time.',
        status: 'ready',
      },
    }),
    page.request
      .post('/api/voice/samples', {
        data: {
          title: 'E2E Voice Sample',
          content: 'This is a sample written in my voice. I write clearly and directly.',
          channelHint: 'blog',
        },
      })
      .catch(() => null),
  ]);
  expect(articleRes.ok()).toBe(true);
  expect(thesisRes.ok()).toBe(true);

  const { article } = await articleRes.json();
  const { thesis } = await thesisRes.json();
  const sample = sampleRes && sampleRes.ok() ? (await sampleRes.json()).sample : { id: 0 };

  // Batch 2: highlight and research in parallel (each depends on one batch-1 result)
  const [highlightRes, researchRes] = await Promise.all([
    page.request.post('/api/highlights', {
      data: { articleId: article.id, text: 'Test content for draft E2E flow.' },
    }),
    page.request.post(`/api/theses/${thesis.id}/research`, {
      data: {
        title: 'Supporting research',
        content: 'Research shows AI assistance reduces drafting time significantly.',
        source: 'manual',
      },
    }),
  ]);
  expect(highlightRes.ok()).toBe(true);
  expect(researchRes.ok()).toBe(true);

  const { highlight } = await highlightRes.json();
  const { research } = await researchRes.json();

  // Batch 3: link highlight to thesis (depends on both)
  const linkRes = await page.request.post(`/api/theses/${thesis.id}/highlights`, {
    data: { highlightIds: [highlight.id], role: 'supporting' },
  });
  expect(linkRes.ok()).toBe(true);

  return {
    articleId: article.id,
    highlightId: highlight.id,
    thesisId: thesis.id,
    researchId: research.id,
    sampleId: sample.id,
  };
}

async function cleanupTestData(page: Page, seed: SeedData): Promise<void> {
  const promises = [
    page.request.delete(`/api/articles/${seed.articleId}`).catch(() => {}),
    page.request.delete(`/api/theses/${seed.thesisId}`).catch(() => {}),
  ];
  if (seed.sampleId) {
    promises.push(page.request.delete(`/api/voice/samples/${seed.sampleId}`).catch(() => {}));
  }
  await Promise.all(promises);
}

test.describe('Draft flow (Module 16)', () => {
  let seed: SeedData;

  test.beforeEach(async ({ page }) => {
    seed = await seedTestData(page);
  });

  test.afterEach(async ({ page }) => {
    await cleanupTestData(page, seed);
  });

  test('create → stream → edit title → publish → verify thesis used → delete', async ({ page }) => {
    // Patch window.fetch before navigation so the generation hook returns mocked SSE
    // instead of calling the real Anthropic API. (Historical note: page.route() used to
    // miss these requests because the service worker mediated them; playwright.config.ts
    // now blocks SWs config-wide, so this monkey-patch could be simplified to a plain
    // page.route stub — see mobile-save.spec.ts for the pattern.)
    const mockSseBody = `event: delta\ndata: {"text":"# ${MOCK_DRAFT_HEADING}\\n\\nGenerated in E2E test."}\n\nevent: done\ndata: {}\n\n`;
    await page.addInitScript((sseBody) => {
      const _fetch = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (
          url.includes('/api/drafts/') &&
          url.includes('/generate') &&
          (init?.method ?? 'GET') === 'POST'
        ) {
          return Promise.resolve(
            new Response(sseBody, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream' },
            }),
          );
        }
        return _fetch(input, init);
      };
    }, mockSseBody);

    // Pin the post-generation race: after streaming completes, the editor
    // refreshes draft metadata via GET /api/drafts/:id. Hold that response until the
    // title has been edited so the refresh always resolves after the user's edit —
    // the buggy version clobbered the edit and the "Saved" indicator never appeared.
    let releaseDraftRefresh!: () => void;
    const draftRefreshGate = new Promise<void>((resolve) => {
      releaseDraftRefresh = resolve;
    });
    // times: 1 — the metadata refresh is the first request to hit this pattern (the
    // generate POST is short-circuited by the fetch mock above), and a lingering route
    // would drag every later autosave PATCH through interception.
    await page.route(
      '**/api/drafts/*',
      async (route) => {
        await draftRefreshGate;
        await route.continue();
      },
      { times: 1 },
    );

    await page.goto(`/theses/${seed.thesisId}`);
    await expect(page.locator('[data-testid="drafts-section"]')).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="new-draft-button"]').click();
    await expect(page.locator('[data-testid="template-picker"]')).toBeVisible({ timeout: 3000 });

    // Picking a template card directly advances to the context-selection step.
    await page.locator('[data-testid="template-card-blog"]').click();

    await expect(page.locator(`[data-testid="picker-highlight-${seed.highlightId}"]`)).toBeChecked({
      timeout: 3000,
    });
    await expect(page.locator(`[data-testid="picker-research-${seed.researchId}"]`)).toBeChecked({
      timeout: 3000,
    });

    await page.locator('[data-testid="picker-angle"]').fill('Lead with the contrarian take');
    await page.locator('[data-testid="picker-submit"]').click();

    await page.waitForURL(/\/drafts\/\d+/, { timeout: 10000 });
    const draftId = parseInt(page.url().split('/drafts/')[1] ?? '0', 10);

    // The editor is a controlled <textarea>; use toHaveValue (not toContainText) to
    // read the element's value property after the SSE stream completes.
    await expect(page.locator('[data-testid="draft-editor"]')).toHaveValue(
      new RegExp(MOCK_DRAFT_HEADING),
      {
        timeout: 15000,
      },
    );

    await page.locator('[data-testid="draft-title"]').fill('Updated E2E Draft Title');
    releaseDraftRefresh();
    await expect(page.locator('[data-testid="save-indicator"]')).toContainText('Saved', {
      timeout: 5000,
    });
    // The race invariant, asserted directly: the edit survived the metadata refresh.
    // Also guards the gate's ordering assumption — even if the route latched the wrong
    // request, a reintroduced clobber would revert this value and fail here.
    await expect(page.locator('[data-testid="draft-title"]')).toHaveValue(
      'Updated E2E Draft Title',
    );

    // Publishing the draft fires an async PATCH to /api/drafts/:id (which also flips
    // the thesis to "used"). Wait on that specific response before reading the thesis
    // back, so the GET can't race ahead of the write.
    const publishResponse = waitForApiResponse(page, `/api/drafts/${draftId}`, 'PATCH');
    await page.locator('[data-testid="toggle-status"]').click();
    expect((await publishResponse).ok()).toBe(true);

    const thesisRes = await page.request.get(`/api/theses/${seed.thesisId}`);
    expect(thesisRes.ok()).toBe(true);
    expect((await thesisRes.json()).thesis.status).toBe('used');

    await page.goto('/drafts');
    const draftCard = page.locator(`[data-testid="draft-card-${draftId}"]`);
    await expect(draftCard).toBeVisible({ timeout: 5000 });
    await expect(draftCard).toContainText('Published');

    await page.goto(`/drafts/${draftId}`);
    await page.locator('[data-testid="delete-draft"]').click();
    await expect(page.locator('[data-testid="delete-confirm"]')).toBeVisible({ timeout: 3000 });
    await page.locator('[data-testid="delete-confirm"]').click();

    await page.waitForURL(`/theses/${seed.thesisId}`, { timeout: 5000 });
    await expect(page.locator(`[data-testid="draft-card-${draftId}"]`)).not.toBeVisible({
      timeout: 3000,
    });

    await page.goto('/drafts');
    await expect(page.locator(`[data-testid="draft-card-${draftId}"]`)).not.toBeVisible({
      timeout: 3000,
    });
  });
});
