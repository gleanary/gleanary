-- Custom SQL migration file, put your code below! --
-- Before article tags became their own vocabulary, POST /api/ai/tag also inserted every
-- suggested name into the highlight `tags` table, without linking it to a highlight.
-- Delete those leftovers: unlinked tags whose name is also some article's AI tag.
-- Malformed ai_tags values read as an empty array, since json_each would fail on them.
DELETE FROM tags
WHERE NOT EXISTS (SELECT 1 FROM highlight_tags WHERE highlight_tags.tag_id = tags.id)
  AND lower(trim(tags.name)) IN (
    SELECT lower(trim(j.value))
    FROM articles,
      json_each(CASE WHEN json_valid(articles.ai_tags) THEN articles.ai_tags ELSE '[]' END) AS j
    WHERE articles.ai_tags IS NOT NULL AND j.type = 'text'
  );
