import { STATUS_CODES } from 'node:http';
import Anthropic from '@anthropic-ai/sdk';
import { NextRequest, NextResponse } from 'next/server';
import { withRoute } from '@/lib/api-error-handler';
import { logger } from '@/lib/logger';
import { testSettingsSchema } from '@/lib/validators';
import { logAudit } from '@/lib/audit';
import { verifySettingsPassword } from '@/lib/settings';
import { getClientIp } from '@/lib/auth';
import { testReadwiseToken } from '@/lib/readwise-import';

const INWORLD_VOICES_URL = 'https://api.inworld.ai/tts/v1/voices';
const MISTRAL_MODELS_URL = 'https://api.mistral.ai/v1/models';

/**
 * POST /api/settings/test — Test an API key without persisting it.
 * Accepts the key in the request body. Requires confirm_password.
 */
export const POST = withRoute('POST /api/settings/test', async (req: NextRequest) => {
  const body = await req.json();
  const data = testSettingsSchema.parse(body);

  const denied = await verifySettingsPassword(data.confirm_password);
  if (denied) return denied;

  const ipAddress = getClientIp(req);
  let success = false;
  let message = '';

  if (data.service === 'inworld') {
    const resp = await fetch(INWORLD_VOICES_URL, {
      headers: { Authorization: `Basic ${data.api_key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      success = true;
      message = 'Inworld API key is valid.';
    } else {
      message = `Inworld API returned ${resp.status}: ${resp.statusText}`;
    }
  } else if (data.service === 'anthropic') {
    // Use the SDK so the key is tested with the same auth header and API version as real calls.
    const client = new Anthropic({ apiKey: data.api_key, timeout: 10_000, maxRetries: 0 });
    try {
      await client.models.list({ limit: 1 });
      success = true;
      message = 'Anthropic API key is valid.';
    } catch (err) {
      if (!(err instanceof Anthropic.APIError) || err.status === undefined) throw err;
      message = `Anthropic API returned ${err.status}: ${STATUS_CODES[err.status] ?? ''}`;
    }
  } else if (data.service === 'readwise') {
    ({ success, message } = await testReadwiseToken(data.api_key));
  } else if (data.service === 'mistral') {
    const resp = await fetch(MISTRAL_MODELS_URL, {
      headers: { Authorization: `Bearer ${data.api_key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      success = true;
      message = 'Mistral API key is valid.';
    } else {
      message = `Mistral API returned ${resp.status}: ${resp.statusText}`;
    }
  }

  logAudit('api_key_tested', `${data.service}_api_key`, {
    ipAddress: ipAddress ?? undefined,
  });

  logger.info(
    { event: 'api_key_tested', service: data.service, success },
    'API key test completed',
  );

  return NextResponse.json({ success, message });
});
