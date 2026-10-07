/**
 * Next.js instrumentation hook — runs once when the server process starts.
 * Used to initialise background schedulers (RSS feed polling, newsletter IMAP polling).
 * Only runs in the Node.js runtime, not in Edge workers.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const [{ initFeedScheduler }, { initNewsletterScheduler }] = await Promise.all([
      import('@/lib/feed-scheduler'),
      import('@/lib/newsletter-scheduler'),
    ]);
    await Promise.all([initFeedScheduler(), initNewsletterScheduler()]);
  }
}
