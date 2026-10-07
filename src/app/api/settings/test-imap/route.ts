import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getImapConfig, createImapClient } from '@/lib/newsletter-poller';
import { logAudit } from '@/lib/audit';
import { getClientIp } from '@/lib/auth';
import { validateHostname } from '@/lib/url-validator';

/**
 * POST /api/settings/test-imap — Test the current IMAP configuration.
 * Reads IMAP settings from the DB (no request body needed).
 * Returns mailbox list on success or an error message on failure.
 */
export async function POST(req: NextRequest) {
  try {
    const imapConfig = await getImapConfig();
    if (!imapConfig) {
      return NextResponse.json(
        {
          success: false,
          error: 'IMAP not configured — fill in host, username, and password in Settings',
        },
        { status: 422 },
      );
    }

    await validateHostname(imapConfig.host);

    const client = createImapClient(imapConfig);

    const connectWithTimeout = new Promise<void>((_resolve, reject) =>
      setTimeout(() => reject(new Error('Connection timed out after 10 seconds')), 10_000),
    );

    const mailboxes: string[] = [];
    try {
      await Promise.race([
        (async () => {
          await client.connect();
          const list = await client.list();
          for (const mailbox of list) {
            mailboxes.push(mailbox.path);
          }
        })(),
        connectWithTimeout,
      ]);
    } finally {
      // Always clean up — runs even when connectWithTimeout wins the race
      await client.logout().catch(() => undefined);
    }

    const ipAddress = getClientIp(req);
    logAudit('api_key_tested', 'imap_host', { ipAddress: ipAddress ?? undefined });
    logger.info(
      { event: 'imap_test_success', mailboxCount: mailboxes.length },
      'IMAP test succeeded',
    );

    return NextResponse.json({ success: true, mailboxes });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ event: 'imap_test_failed', err: error }, 'IMAP test failed');
    return NextResponse.json({ success: false, error: message });
  }
}
