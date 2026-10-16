import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { http, HttpResponse } from 'msw';
import { server, setupHandlers } from '../mocks/server';

const dbMock = await vi.hoisted(async () => (await import('./setup')).createDbMock());
vi.mock('@/db', () => dbMock.mock);

import { resetClient } from '@/lib/ai';
import { expectActiveModel } from '../mocks/active-models';
import { GET as getProfile, PUT as putProfile } from '@/app/api/voice/profile/route';
import { POST as extractProfile } from '@/app/api/voice/profile/extract/route';
import { GET as listSamples, POST as createSample } from '@/app/api/voice/samples/route';
import { PATCH as updateSample, DELETE as deleteSample } from '@/app/api/voice/samples/[id]/route';

const PROFILE_TEXT = [
  '## Rhythm & Sentence Structure',
  'Short and long sentences alternate. > Evidence: "example phrase"',
  '',
  '## Vocabulary & Register',
  'Clear technical vocabulary. > Evidence: "example"',
  '',
  '## Argument Construction',
  'Claim first, then evidence. > Evidence: "example"',
  '',
  '## Opening Patterns',
  'Direct hook or question. > Evidence: "example"',
  '',
  '## Closing Patterns',
  'Open question or reframe. > Evidence: "example"',
  '',
  '## Rhetorical Devices',
  'Analogies sparingly. > Evidence: "example"',
  '',
  '## Tone & Confidence',
  'Confident and direct. > Evidence: "example"',
  '',
  '## Anti-Patterns',
  'Avoids hedging. > Evidence: absence noted',
].join('\n');

function sseProfile(text: string): string {
  const textJson = JSON.stringify(text);
  return [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-20250514","stop_reason":null,"usage":{"input_tokens":500,"output_tokens":0}}}\n\n`,
    `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${textJson}}}\n\n`,
    `event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":200}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ].join('');
}

setupHandlers(
  http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>;
    if (body.stream) {
      return new HttpResponse(sseProfile(PROFILE_TEXT), {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }
    return HttpResponse.json({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: PROFILE_TEXT }],
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn',
      usage: { input_tokens: 500, output_tokens: 200 },
    });
  }),
);

function jsonReq(method: string, url: string, body?: object) {
  return new NextRequest(new URL(url, 'http://localhost:3000'), {
    method,
    ...(body
      ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

function routeContext(id: number) {
  return { params: Promise.resolve({ id: String(id) }) };
}

const LONG_SAMPLE = 'This is a well-written paragraph demonstrating voice. '.repeat(30);

beforeEach(() => {
  dbMock.setup();
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test-dummy-key');
  resetClient();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/voice/profile', () => {
  it('returns null when no profile exists', async () => {
    const res = await getProfile(jsonReq('GET', '/api/voice/profile'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toBeNull();
    expect(body.sampleCount).toBe(0);
  });
});

describe('PUT /api/voice/profile', () => {
  it('creates a profile when none exists', async () => {
    const profileText = 'a'.repeat(150);
    const res = await putProfile(jsonReq('PUT', '/api/voice/profile', { profile: profileText }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.profile).toBe(profileText);
    expect(body.profile.manualEditsAt).toBeTruthy();
  });

  it('updates an existing profile', async () => {
    const first = 'a'.repeat(150);
    const second = 'b'.repeat(150);
    await putProfile(jsonReq('PUT', '/api/voice/profile', { profile: first }));
    const res = await putProfile(jsonReq('PUT', '/api/voice/profile', { profile: second }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.profile).toBe(second);
  });

  it('returns 422 when profile text is under 100 chars', async () => {
    const res = await putProfile(jsonReq('PUT', '/api/voice/profile', { profile: 'short' }));
    expect(res.status).toBe(422);
  });

  it('returns 422 when profile text exceeds 10000 chars', async () => {
    const res = await putProfile(
      jsonReq('PUT', '/api/voice/profile', { profile: 'x'.repeat(10001) }),
    );
    expect(res.status).toBe(422);
  });
});

describe('GET /api/voice/samples', () => {
  it('returns empty list when no samples exist', async () => {
    const res = await listSamples(jsonReq('GET', '/api/voice/samples'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.samples).toEqual([]);
  });

  it('returns samples after creation', async () => {
    await createSample(
      jsonReq('POST', '/api/voice/samples', {
        title: 'My Sample',
        content: LONG_SAMPLE,
      }),
    );
    const res = await listSamples(jsonReq('GET', '/api/voice/samples'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.samples).toHaveLength(1);
    expect(body.samples[0].title).toBe('My Sample');
  });
});

describe('POST /api/voice/samples', () => {
  it('creates a sample with all fields', async () => {
    const res = await createSample(
      jsonReq('POST', '/api/voice/samples', {
        title: 'Blog post',
        content: LONG_SAMPLE,
        channelHint: 'blog, long-form',
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sample.title).toBe('Blog post');
    expect(body.sample.channelHint).toBe('blog, long-form');
    expect(body.sample.wordCount).toBeGreaterThan(0);
  });

  it('creates a sample with minimal fields', async () => {
    const res = await createSample(
      jsonReq('POST', '/api/voice/samples', {
        title: 'Minimal',
        content: LONG_SAMPLE,
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sample.channelHint).toBeNull();
  });

  it('computes word count server-side', async () => {
    const content = 'one two three four five '.repeat(20);
    const res = await createSample(
      jsonReq('POST', '/api/voice/samples', { title: 'Count test', content }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.sample.wordCount).toBe(100);
  });

  it('returns 422 when content is under 100 chars', async () => {
    const res = await createSample(
      jsonReq('POST', '/api/voice/samples', { title: 'Short', content: 'too short' }),
    );
    expect(res.status).toBe(422);
  });

  it('returns 422 when content exceeds 50000 chars', async () => {
    const res = await createSample(
      jsonReq('POST', '/api/voice/samples', {
        title: 'Too big',
        content: 'x'.repeat(50001),
      }),
    );
    expect(res.status).toBe(422);
  });

  it('auto-creates profile row if none exists', async () => {
    await createSample(
      jsonReq('POST', '/api/voice/samples', { title: 'First', content: LONG_SAMPLE }),
    );
    // Profile should now exist (returned by GET)
    const res = await getProfile(jsonReq('GET', '/api/voice/profile'));
    const body = await res.json();
    expect(body.profile).not.toBeNull();
  });
});

describe('PATCH /api/voice/samples/[id]', () => {
  let sampleId: number;

  beforeEach(async () => {
    const res = await createSample(
      jsonReq('POST', '/api/voice/samples', {
        title: 'Original title',
        content: LONG_SAMPLE,
      }),
    );
    const body = await res.json();
    sampleId = body.sample.id;
  });

  it('updates title only', async () => {
    const res = await updateSample(
      jsonReq('PATCH', `/api/voice/samples/${sampleId}`, { title: 'New title' }),
      routeContext(sampleId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sample.title).toBe('New title');
  });

  it('updates channelHint to a value', async () => {
    const res = await updateSample(
      jsonReq('PATCH', `/api/voice/samples/${sampleId}`, { channelHint: 'tech, blog' }),
      routeContext(sampleId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sample.channelHint).toBe('tech, blog');
  });

  it('clears channelHint with null', async () => {
    await updateSample(
      jsonReq('PATCH', `/api/voice/samples/${sampleId}`, { channelHint: 'tech' }),
      routeContext(sampleId),
    );
    const res = await updateSample(
      jsonReq('PATCH', `/api/voice/samples/${sampleId}`, { channelHint: null }),
      routeContext(sampleId),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sample.channelHint).toBeNull();
  });

  it('returns 404 for nonexistent sample', async () => {
    const res = await updateSample(
      jsonReq('PATCH', '/api/voice/samples/9999', { title: 'x' }),
      routeContext(9999),
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/voice/samples/[id]', () => {
  it('deletes an existing sample', async () => {
    const createRes = await createSample(
      jsonReq('POST', '/api/voice/samples', { title: 'To delete', content: LONG_SAMPLE }),
    );
    const { sample } = await createRes.json();

    const res = await deleteSample(
      jsonReq('DELETE', `/api/voice/samples/${sample.id}`),
      routeContext(sample.id),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });

  it('returns 404 for nonexistent sample', async () => {
    const res = await deleteSample(
      jsonReq('DELETE', '/api/voice/samples/9999'),
      routeContext(9999),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/voice/profile/extract', () => {
  async function seedSamples(count: number) {
    for (let i = 0; i < count; i++) {
      await createSample(
        jsonReq('POST', '/api/voice/samples', {
          title: `Sample ${i + 1}`,
          content: LONG_SAMPLE,
        }),
      );
    }
  }

  it('returns 422 when fewer than 3 samples exist', async () => {
    await seedSamples(2);
    const res = await extractProfile(jsonReq('POST', '/api/voice/profile/extract', {}));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.currentCount).toBe(2);
  });

  it('extracts profile with 3+ samples', async () => {
    let requestedModel: unknown;
    server.use(
      http.post('https://api.anthropic.com/v1/messages', async ({ request }) => {
        requestedModel = ((await request.json()) as { model?: unknown }).model;
        return new HttpResponse(sseProfile(PROFILE_TEXT), {
          headers: { 'Content-Type': 'text/event-stream' },
        });
      }),
    );

    await seedSamples(3);
    const res = await extractProfile(jsonReq('POST', '/api/voice/profile/extract', {}));
    expect(res.status).toBe(200);
    expectActiveModel(requestedModel);
    const body = await res.json();
    expect(body.profile.profile).toContain('## Rhythm & Sentence Structure');
    expect(typeof body.tokensUsed).toBe('number');
    expect(body.tokensUsed).toBeGreaterThan(0);
    expect(body.profile.extractedAt).toBeTruthy();
    expect(body.profile.sampleCount).toBe(3);
  });

  it('returns 409 when manual edits exist and force=false', async () => {
    await putProfile(jsonReq('PUT', '/api/voice/profile', { profile: 'x'.repeat(150) }));
    await seedSamples(3);
    const res = await extractProfile(
      jsonReq('POST', '/api/voice/profile/extract', { force: false }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.manualEditsAt).toBeTruthy();
  });

  it('overwrites manual edits when force=true', async () => {
    await putProfile(jsonReq('PUT', '/api/voice/profile', { profile: 'x'.repeat(150) }));
    await seedSamples(3);
    const res = await extractProfile(
      jsonReq('POST', '/api/voice/profile/extract', { force: true }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile.profile).toContain('## Rhythm & Sentence Structure');
    expect(body.profile.manualEditsAt).toBeNull();
  });

  it('clears manualEditsAt after successful extraction', async () => {
    await putProfile(jsonReq('PUT', '/api/voice/profile', { profile: 'x'.repeat(150) }));
    await seedSamples(3);
    await extractProfile(jsonReq('POST', '/api/voice/profile/extract', { force: true }));

    const res = await getProfile(jsonReq('GET', '/api/voice/profile'));
    const body = await res.json();
    expect(body.profile.manualEditsAt).toBeNull();
  });
});

describe('Cascade delete', () => {
  it('deleting profile row cascades to samples', async () => {
    // Create 2 samples (which auto-creates profile row)
    const s1 = await createSample(
      jsonReq('POST', '/api/voice/samples', { title: 'A', content: LONG_SAMPLE }),
    );
    const s2 = await createSample(
      jsonReq('POST', '/api/voice/samples', { title: 'B', content: LONG_SAMPLE }),
    );
    const { sample: sample1 } = await s1.json();
    const { sample: sample2 } = await s2.json();

    // Manually delete the profile row to test cascade
    const db = dbMock.mock.db!;
    const { voiceProfile } = await import('@/db/schema');
    await db.delete(voiceProfile);

    // Both samples should be gone
    const del1 = await deleteSample(
      jsonReq('DELETE', `/api/voice/samples/${sample1.id}`),
      routeContext(sample1.id),
    );
    expect(del1.status).toBe(404);

    const del2 = await deleteSample(
      jsonReq('DELETE', `/api/voice/samples/${sample2.id}`),
      routeContext(sample2.id),
    );
    expect(del2.status).toBe(404);
  });
});
