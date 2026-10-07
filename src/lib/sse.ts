/**
 * Server-Sent Events (SSE) utilities for streaming responses.
 * Provides helpers to format and send SSE events to clients.
 */

/** Response headers for SSE endpoints */
export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

/**
 * Formats an SSE event with type and data as a Uint8Array for streaming.
 * @param eventType - Event type string (e.g., 'delta', 'done')
 * @param data - Data object to serialize
 * @returns Uint8Array containing the formatted SSE event
 */
export function sseEvent(eventType: string, data: unknown): Uint8Array {
  const jsonData = JSON.stringify(data);
  const eventStr = `event: ${eventType}\ndata: ${jsonData}\n\n`;
  return new TextEncoder().encode(eventStr);
}
