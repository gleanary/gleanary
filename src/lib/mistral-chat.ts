import { ExternalServiceError } from '@/lib/errors';
import { getConfig } from '@/lib/settings';
import { trackAiCall } from '@/lib/ai-usage';
import type { TrackingContext } from '@/lib/ai-usage';

const MISTRAL_CHAT_URL = 'https://api.mistral.ai/v1/chat/completions';

/**
 * Ministral 3 8B (v25.12). Date-stamped ID sent in the request body so the
 * response echoes back the same ID — this keeps it stable against MODEL_PRICING
 * lookups without normalisation.
 */
export const MISTRAL_REFORMAT_MODEL = 'ministral-8b-2512';

const DEFAULT_TIMEOUT_MS = 300_000;

/** Result returned by callMistralChat. */
export interface MistralChatResult {
  text: string;
  /** 'stop' = normal completion; 'length' = truncated by max_tokens. */
  stopReason: 'stop' | 'length';
  model: string;
}

/**
 * Send a chat completion request to Mistral and return the response text.
 * Wraps the fetch call in trackAiCall so an ai_usage row is written on both
 * success and failure. Throws ExternalServiceError before entering trackAiCall
 * if the API key is missing (consistent with the OCR pattern — no row written).
 *
 * @param systemPrompt - System instructions
 * @param userMessage - User message content
 * @param ctx - Tracking context for ai_usage recording
 * @param options - Optional overrides (max tokens, timeout)
 * @returns { text, stopReason, model }
 * @throws ExternalServiceError on missing key, auth failure, or provider error
 */
export async function callMistralChat(
  systemPrompt: string,
  userMessage: string,
  ctx: TrackingContext,
  options?: { maxTokens?: number; timeoutMs?: number },
): Promise<MistralChatResult> {
  const apiKey = getConfig('mistral_api_key');
  if (!apiKey) {
    throw new ExternalServiceError(
      'Mistral',
      'API key not configured. Add MISTRAL_API_KEY in Settings → Integrations.',
      503,
    );
  }

  const maxTokens = options?.maxTokens ?? 32_768;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return await trackAiCall({ ...ctx, model: MISTRAL_REFORMAT_MODEL }, async () => {
    let response: Response;
    try {
      response = await fetch(MISTRAL_CHAT_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MISTRAL_REFORMAT_MODEL,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userMessage },
          ],
          max_tokens: maxTokens,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new ExternalServiceError('Mistral', `Request failed: ${String(err)}`, 503);
    }

    if (!response.ok) {
      const status = response.status;
      if (status === 401) {
        throw new ExternalServiceError(
          'Mistral',
          'Invalid Mistral API key. Check Settings → Integrations.',
          503,
        );
      }
      throw new ExternalServiceError('Mistral', `Mistral request failed (HTTP ${status}).`, 503);
    }

    let data: {
      choices: Array<{ message: { content: string }; finish_reason: string }>;
      usage: { prompt_tokens: number; completion_tokens: number };
      model: string;
    };
    try {
      data = await response.json();
    } catch {
      throw new ExternalServiceError('Mistral', 'Invalid JSON in chat response.', 503);
    }

    const choice = data.choices?.[0];
    if (!choice) {
      throw new ExternalServiceError('Mistral', 'Empty choices array in response.', 503);
    }

    const text = choice.message?.content ?? '';
    const stopReason = choice.finish_reason === 'stop' ? 'stop' : 'length';
    const model = data.model ?? MISTRAL_REFORMAT_MODEL;

    return {
      result: { text, stopReason, model },
      usage: {
        model,
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        webSearchCount: 0,
      },
    };
  });
}
