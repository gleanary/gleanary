import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db';
import { articles, sources } from '@/db/schema';
import { LOGIN_PAGE_HEADER } from '@/lib/auth';
import { countDueHighlights } from '@/lib/spaced-repetition';
import { logger } from '@/lib/logger';
import { AppShell } from '@/components/layout/app-shell';
import { THEME_BOOTSTRAP_SCRIPT, SERVICE_WORKER_SCRIPT } from '@/lib/inline-scripts';
import type { SidebarData } from '@/components/layout/sidebar';
import './globals.css';
import 'katex/dist/katex.min.css';

export const metadata: Metadata = {
  title: 'Gleanary',
  description: 'Personal read-it-later and highlight management',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'default',
    title: 'Gleanary',
  },
};

export const viewport: Viewport = {
  // Lock zoom so the app behaves like a native shell on mobile (no pinch/double-tap zoom)
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FAFAF7' },
    { media: '(prefers-color-scheme: dark)', color: '#151c23' },
  ],
};

const EMPTY_SIDEBAR_DATA: SidebarData = {
  counts: { inbox: 0, reading: 0, archived: 0, allArticles: 0, dueReviews: 0 },
  feeds: [],
};

/** Fetches sidebar navigation data (counts, feeds). */
function getSidebarData(): SidebarData {
  try {
    // Single query for all article status counts via conditional aggregation
    const articleCounts = db
      .select({
        total: sql<number>`count(*)`,
        inbox: sql<number>`sum(CASE WHEN ${articles.status} = 'inbox' THEN 1 ELSE 0 END)`,
        reading: sql<number>`sum(CASE WHEN ${articles.status} = 'reading' THEN 1 ELSE 0 END)`,
        archived: sql<number>`sum(CASE WHEN ${articles.status} = 'archived' THEN 1 ELSE 0 END)`,
      })
      .from(articles)
      .get();

    const feeds = db
      .select({ id: sources.id, name: sources.name, iconUrl: sources.iconUrl })
      .from(sources)
      .where(eq(sources.type, 'rss_feed'))
      .all();

    return {
      counts: {
        inbox: articleCounts?.inbox ?? 0,
        reading: articleCounts?.reading ?? 0,
        archived: articleCounts?.archived ?? 0,
        allArticles: articleCounts?.total ?? 0,
        dueReviews: countDueHighlights(),
      },
      feeds,
    };
  } catch (error) {
    logger.error({ err: error, event: 'sidebar_data_failed' }, 'Failed to fetch sidebar data');
    return EMPTY_SIDEBAR_DATA;
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The proxy marks /login requests; render it bare so no sidebar data
  // (feed names, counts) is fetched or serialized for unauthenticated visitors.
  const isLoginPage = (await headers()).get(LOGIN_PAGE_HEADER) === '1';
  const sidebarData = isLoginPage ? EMPTY_SIDEBAR_DATA : getSidebarData();

  return (
    <html lang="en" suppressHydrationWarning>
      {/* Inline script runs before first paint to prevent FOUC.
          Reads appearance_mode from localStorage and applies .dark class.
          Falls back to system prefers-color-scheme when mode is 'automatic'. */}
      <head>
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }}
        />
      </head>
      <body className="bg-background text-foreground overflow-x-hidden antialiased">
        {isLoginPage ? children : <AppShell sidebarData={sidebarData}>{children}</AppShell>}
        {/* Service worker registration for PWA installability — static string, no XSS risk */}
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: SERVICE_WORKER_SCRIPT }}
        />
      </body>
    </html>
  );
}
