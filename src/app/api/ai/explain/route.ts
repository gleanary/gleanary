import { NextRequest, NextResponse } from 'next/server';
import { explainSchema } from '@/lib/validators';
import { callClaude, truncateContent, EXPLAIN_MODES } from '@/lib/ai';
import { logger } from '@/lib/logger';
import { withRoute } from '@/lib/api-error-handler';
import { getArticleOrThrow, getHighlightOrThrow } from '@/lib/db-helpers';

/**
 * POST /api/ai/explain — Explain a highlighted passage using Claude.
 * Supports "explain" and "importance" modes. Not cached (always fresh).
 * @param req - NextRequest with JSON body { highlightId: number, mode?: 'explain' | 'importance' }
 * @returns Explanation text
 */
export const POST = withRoute('POST /api/ai/explain', async (req: NextRequest) => {
  const body = await req.json();
  const { highlightId, mode } = explainSchema.parse(body);

  const highlight = getHighlightOrThrow(highlightId);
  const article = getArticleOrThrow(highlight.articleId);

  const systemPrompt = EXPLAIN_MODES[mode];

  const articleContext = article.contentMarkdown ?? article.contentText ?? article.title;
  const userMessage = `Article: "${article.title}"\n\nArticle context:\n${truncateContent(articleContext)}\n\nHighlighted passage:\n"${highlight.text}"`;

  const explanation = await callClaude(systemPrompt, userMessage, {
    feature: 'explain',
    resourceType: 'highlight',
    resourceId: highlightId,
  });

  logger.info(
    { event: 'ai_explain', highlightId, articleId: highlight.articleId, mode },
    'Highlight explained',
  );
  return NextResponse.json({ explanation });
});
