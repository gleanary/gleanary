import 'server-only';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { eq } from 'drizzle-orm';
import { db } from '@/db';
import { sources, articles } from '@/db/schema';
import { sanitizeArticleHtml } from '@/lib/sanitize';
import { preprocessEmailHtml } from '@/lib/email-preprocessor';
import { convertHtmlToMarkdown } from '@/lib/html-to-markdown';
import { computeWordCount, stripHtml, truncate } from '@/lib/text-utils';
import { logger } from '@/lib/logger';
import { getSetting } from '@/lib/settings';
import type { NewsletterPollResult } from '@/types';

interface ImapConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  tls: boolean;
  mailbox: string;
}

/**
 * Reads IMAP configuration from the settings DB.
 * @returns Config object or null if host/user/password are not set.
 */
export async function getImapConfig(): Promise<ImapConfig | null> {
  const host = await getSetting('imap_host');
  const user = await getSetting('imap_user');
  const password = await getSetting('imap_password');
  if (!host || !user || !password) return null;
  const port = parseInt((await getSetting('imap_port')) || '993', 10);
  const tls = (await getSetting('imap_tls')) !== 'false';
  const mailbox = (await getSetting('imap_mailbox')) || 'INBOX';
  return { host, port, user, password, tls, mailbox };
}

/** Maximum email size to process (5 MB) */
const MAX_EMAIL_SIZE_BYTES = 5 * 1024 * 1024;

/**
 * Creates a configured ImapFlow client with standard timeout settings and
 * a no-op error handler to prevent socket timeout errors from leaking as uncaughtException.
 * @param config - IMAP configuration
 * @returns Configured ImapFlow instance
 */
export function createImapClient(config: ImapConfig): ImapFlow {
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.tls,
    auth: { user: config.user, pass: config.password },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 120_000,
  });
  // Prevent socket timeout errors from leaking as uncaughtException
  client.on('error', () => {});
  return client;
}

/**
 * Wraps plain text content in HTML paragraph tags.
 * Escapes HTML entities to prevent content loss from angle brackets.
 * @param text - Plain text content
 * @returns HTML string with paragraphs
 */
function wrapPlainTextAsHtml(text: string): string {
  return text
    .split(/\n\n+/)
    .map((para) => {
      const escaped = para.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      return `<p>${escaped.replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

/**
 * Generates a deterministic internal URL for a newsletter article based on Message-ID.
 * @param messageId - Email Message-ID header value
 * @returns Internal URL path
 */
function generateNewsletterUrl(messageId: string): string {
  const hash = messageId.replace(/[<>]/g, '').replace(/[^a-zA-Z0-9]/g, '-');
  return `newsletter://${hash}`;
}

/**
 * Polls the configured IMAP mailbox for unread newsletter emails,
 * processes them, and saves as articles.
 *
 * New senders are created with `isBlocked: null` (pending).
 * Articles from pending senders are saved but excluded from the main inbox.
 * Blocked senders' emails are marked as read and skipped.
 * Approved senders' articles go directly to inbox.
 * @returns Poll result with counts and errors
 */
export async function pollNewsletters(): Promise<NewsletterPollResult> {
  const result: NewsletterPollResult = {
    newArticles: 0,
    skipped: 0,
    errors: [],
  };

  const imapConfig = await getImapConfig();
  if (!imapConfig) {
    result.errors.push(
      'IMAP is not configured (set imap_host, imap_user, imap_password in Settings)',
    );
    return result;
  }

  const client = createImapClient(imapConfig);

  try {
    await client.connect();
  } catch (error) {
    const msg = `IMAP connection failed: ${String(error)}`;
    result.errors.push(msg);
    logger.error({ err: error, event: 'newsletter_imap_connect_failed' }, msg);
    return result;
  }

  try {
    logger.info(
      { event: 'newsletter_mailbox_opening', mailbox: imapConfig.mailbox },
      'Opening mailbox',
    );
    await client.mailboxOpen(imapConfig.mailbox);
    logger.info({ event: 'newsletter_mailbox_opened' }, 'Mailbox opened');

    // Use UID mode throughout — UIDs are stable, sequence numbers change when messages are added/deleted
    const allUids = await client.search({ seen: false }, { uid: true });
    const uidList = Array.isArray(allUids) ? allUids : [];
    logger.info({ event: 'newsletter_search_done', count: uidList.length }, 'Search complete');
    if (uidList.length === 0) {
      logger.info({ event: 'newsletter_poll_no_messages' }, 'No unread messages');
      return result;
    }

    // Process the 50 most recent unseen messages per poll to avoid connection timeouts
    const uids = uidList.slice(-50);
    if (uidList.length > 50) {
      logger.info(
        { event: 'newsletter_poll_truncated', total: uidList.length, processing: uids.length },
        'Large unseen backlog — processing 50 most recent messages this cycle',
      );
    }

    logger.info({ event: 'newsletter_fetch_start', uids: uids.length }, 'Starting fetch');
    for (const uid of uids) {
      try {
        const message = await client.fetchOne(
          String(uid),
          { source: true, uid: true, size: true },
          { uid: true },
        );

        if (!message) {
          logger.warn({ event: 'newsletter_null_message', uid }, 'No message returned, skipping');
          result.skipped++;
          await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
          continue;
        }

        logger.info(
          { event: 'newsletter_message_meta', uid: message.uid, size: message.size },
          'Message metadata',
        );

        const rawSource = message.source;
        if (!rawSource) {
          logger.warn(
            { event: 'newsletter_null_source', uid: message.uid },
            'Message has no source, skipping',
          );
          result.skipped++;
          await client.messageFlagsAdd(String(message.uid), ['\\Seen'], { uid: true });
          continue;
        }
        if (rawSource.length > MAX_EMAIL_SIZE_BYTES) {
          logger.warn(
            { event: 'newsletter_email_too_large', uid: message.uid, size: rawSource.length },
            'Email too large, skipping',
          );
          result.skipped++;
          await client.messageFlagsAdd(String(message.uid), ['\\Seen'], { uid: true });
          continue;
        }

        const parsed = await simpleParser(rawSource, {});

        // Extract sender info
        const senderAddress = parsed.from?.value?.[0]?.address ?? 'unknown@unknown';
        const senderName =
          parsed.from?.value?.[0]?.name ?? senderAddress.split('@')[0] ?? 'Unknown';
        const messageId = parsed.messageId ?? `<unknown-${Date.now()}@local>`;

        // Check for duplicate by Message-ID
        const existing = db
          .select({ id: articles.id })
          .from(articles)
          .where(eq(articles.externalId, messageId))
          .get();

        if (existing) {
          logger.debug({ event: 'newsletter_duplicate', messageId }, 'Duplicate email, skipping');
          result.skipped++;
          await client.messageFlagsAdd(String(message.uid), ['\\Seen'], { uid: true });
          continue;
        }

        // Find or create source for this sender
        let source = db
          .select()
          .from(sources)
          .where(eq(sources.senderAddress, senderAddress))
          .get();

        // Blocked senders: mark as read and skip
        if (source && source.isBlocked === true) {
          logger.debug(
            { event: 'newsletter_blocked', senderAddress },
            'Sender is blocked, skipping',
          );
          result.skipped++;
          await client.messageFlagsAdd(String(message.uid), ['\\Seen'], { uid: true });
          continue;
        }

        // New sender: create with pending status (isBlocked = null)
        if (!source) {
          source = db
            .insert(sources)
            .values({
              type: 'newsletter',
              name: senderName,
              senderAddress,
            })
            .returning()
            .get();

          logger.info(
            { event: 'newsletter_new_sender', senderAddress, sourceId: source.id },
            'New newsletter sender detected (pending approval)',
          );
        }

        // Extract content
        const rawEmailHtml = parsed.html && typeof parsed.html === 'string' ? parsed.html : null;
        let contentHtml: string;
        if (rawEmailHtml) {
          contentHtml = sanitizeArticleHtml(preprocessEmailHtml(rawEmailHtml));
        } else if (parsed.text) {
          contentHtml = sanitizeArticleHtml(wrapPlainTextAsHtml(parsed.text));
        } else {
          logger.warn(
            { event: 'newsletter_no_content', uid: message.uid },
            'Email has no content, skipping',
          );
          result.skipped++;
          await client.messageFlagsAdd(String(message.uid), ['\\Seen'], { uid: true });
          continue;
        }

        const contentText = stripHtml(contentHtml);
        const contentMarkdown = convertHtmlToMarkdown(contentHtml);
        const wordCount = computeWordCount(contentText);
        const excerpt = truncate(contentText);
        const title =
          (parsed.subject ?? '').replace(/^(fwd:\s*)*/i, '').trim() || 'Untitled Newsletter';
        const author = senderName;
        const publishedAt = parsed.date?.toISOString() ?? null;
        const url = generateNewsletterUrl(messageId);
        const siteName = senderAddress.split('@')[1] ?? null;

        // Save article — status depends on source approval
        const articleStatus = source.isBlocked === false ? 'inbox' : 'pending_review';

        db.insert(articles)
          .values({
            url,
            title,
            author,
            contentHtml,
            contentText,
            contentOriginalHtml: rawEmailHtml,
            contentMarkdown,
            excerpt,
            siteName,
            wordCount,
            sourceId: source.id,
            externalId: messageId,
            publishedAt,
            status: articleStatus,
          })
          .run();

        // Update source lastReceivedAt
        db.update(sources)
          .set({ lastReceivedAt: new Date().toISOString() })
          .where(eq(sources.id, source.id))
          .run();

        result.newArticles++;
        logger.info(
          {
            event: 'newsletter_article_saved',
            messageId,
            sender: senderAddress,
            title,
            status: articleStatus,
          },
          `Newsletter article saved (${articleStatus})`,
        );

        // Mark email as read
        await client.messageFlagsAdd(String(message.uid), ['\\Seen'], { uid: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'NoConnection' || code === 'ETIMEOUT') {
          logger.warn(
            { event: 'newsletter_fetch_interrupted', uid, newArticles: result.newArticles },
            'IMAP connection interrupted fetching message — stopping batch',
          );
          break; // connection is dead, stop trying further messages
        }
        const msg = `Failed to process email uid=${uid}: ${String(error)}`;
        result.errors.push(msg);
        logger.error({ err: error, event: 'newsletter_process_failed', uid }, msg);
      }
    }
  } catch (error) {
    // mailboxOpen or search error
    const msg = `Newsletter poll failed: ${String(error)}`;
    result.errors.push(msg);
    logger.error({ err: error, event: 'newsletter_poll_failed' }, msg);
  } finally {
    try {
      await client.logout();
    } catch {
      // Ignore logout errors
    }
  }

  logger.info(
    {
      event: 'newsletter_poll',
      newArticles: result.newArticles,
      skipped: result.skipped,
      errors: result.errors.length,
    },
    'Newsletter poll completed',
  );

  return result;
}
