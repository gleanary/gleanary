'use client';

import { useEffect } from 'react';
import { ContextPanelPortal } from '@/components/layout/context-panel';
import { Field } from '@/components/context-panel/field';
import { TextBlock } from '@/components/context-panel/text-block';
import { TagList } from '@/components/context-panel/tag-list';
import { GenerateAction, clearGenerateErrors } from '@/components/context-panel/generate-action';
import { useArticle } from '@/components/reader/article-context';
import { formatDate, parseAiTags, readingTime } from '@/lib/text-utils';
import type { Article, ContextPanelTab } from '@/types';

interface ReaderContextPanelProps {
  /** Name of the article's source (RSS feed or newsletter), when it has one. */
  sourceName: string | null;
  /** Whether an Anthropic API key is configured (enables Generate). */
  aiAvailable: boolean;
}

/** Page count for PDFs, otherwise word count and reading time; null when unknown. */
function lengthLabel({ wordCount, pageCount }: Article): string | null {
  if (pageCount) return readingTime(wordCount, pageCount);
  if (!wordCount) return null;
  return `${wordCount.toLocaleString('en-US')} words · ${readingTime(wordCount)}`;
}

/**
 * The reader page's context panel: one Details tab with the article's metadata (About),
 * its AI summary and its AI tags, each with a Generate empty state. Rendered inside the
 * reader's providers and portaled into the shell, so it re-renders from `useArticle()`.
 * @param props.sourceName - Name of the article's source, or null
 * @param props.aiAvailable - Whether an Anthropic API key is configured
 * @returns The panel portal
 */
export function ReaderContextPanel({ sourceName, aiAvailable }: ReaderContextPanelProps) {
  const { article } = useArticle();
  const aiTags = parseAiTags(article.aiTags);
  // A failed Generate shows its error for this visit only
  const articleId = article.id;
  useEffect(() => () => clearGenerateErrors(articleId), [articleId]);

  const tabs: ContextPanelTab[] = [
    {
      id: 'details',
      label: 'Details',
      sections: [
        {
          id: 'about',
          label: 'About',
          content: (
            <dl className="flex flex-col gap-1.5">
              <Field label="Author" value={article.author} />
              <Field label="Site" value={article.siteName} />
              {article.sourceId != null && <Field label="Source" value={sourceName} />}
              <Field
                label="Published"
                value={article.publishedAt ? formatDate(article.publishedAt) : null}
              />
              <Field label="Saved" value={formatDate(article.savedAt)} />
              {article.readAt && <Field label="Read" value={formatDate(article.readAt)} />}
              <Field label="Length" value={lengthLabel(article)} />
            </dl>
          ),
        },
        {
          id: 'summary',
          label: 'Summary',
          content: (
            <TextBlock
              value={article.aiSummary}
              emptyState={<GenerateAction kind="summary" aiAvailable={aiAvailable} />}
            />
          ),
        },
        {
          id: 'tags',
          label: 'Tags',
          content: (
            <TagList
              tags={aiTags}
              emptyState={<GenerateAction kind="tags" aiAvailable={aiAvailable} />}
            />
          ),
        },
      ],
    },
  ];

  return <ContextPanelPortal title="Details" tabs={tabs} />;
}
