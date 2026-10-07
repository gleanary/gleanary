import { NextRequest, NextResponse } from 'next/server';
import { withRoute } from '@/lib/api-error-handler';
import { logger } from '@/lib/logger';
import { testSettingsSchema } from '@/lib/validators';
import { logAudit } from '@/lib/audit';
import { verifySettingsPassword } from '@/lib/settings';
import { getClientIp } from '@/lib/auth';
import { testReadwiseToken } from '@/lib/readwise-import';

const INWORLD_VOICES_URL = 'https://api.inworld.ai/tts/v1/voices';
const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models';
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
    const resp = await fetch(ANTHROPIC_MODELS_URL, {
      headers: {
        'x-api-key': data.api_key,
        'anthropic-version': '2023-06-01',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.ok) {
      success = true;
      message = 'Anthropic API key is valid.';
    } else {
      message = `Anthropic API returned ${resp.status}: ${resp.statusText}`;
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
