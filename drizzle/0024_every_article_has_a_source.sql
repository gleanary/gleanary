-- Hand-edited (docs/modules/article-enrichment.md §4.1): the backfill below runs
-- before the unique index is created and before the rebuild copies source_id into a
-- NOT NULL column. The singleton type list ('web_save','upload','readwise') mirrors
-- SINGLETON_SOURCE_TYPES in src/types/index.ts (SQL can't import it): keep them in
-- sync. The parity test in __tests__/integration/migrate-runner.test.ts checks it.
-- 1. Merge duplicate singletons (possible today: sources.type has no constraint).
--    Keep the lowest id per type, repoint its articles, delete the rest.
UPDATE articles SET source_id = (
    SELECT MIN(keep.id) FROM sources keep
    WHERE keep.type = (SELECT dup.type FROM sources dup WHERE dup.id = articles.source_id)
  )
  WHERE source_id IN (
    SELECT id FROM sources
    WHERE type IN ('web_save','upload','readwise')
      AND id NOT IN (SELECT MIN(id) FROM sources WHERE type IN ('web_save','upload','readwise') GROUP BY type)
  );
--> statement-breakpoint
DELETE FROM sources
  WHERE type IN ('web_save','upload','readwise')
    AND id NOT IN (SELECT MIN(id) FROM sources WHERE type IN ('web_save','upload','readwise') GROUP BY type);
--> statement-breakpoint
-- 2. Create the web_save singleton.
INSERT INTO sources (type, name)
  SELECT 'web_save', 'Web saves'
  WHERE NOT EXISTS (SELECT 1 FROM sources WHERE type = 'web_save');
--> statement-breakpoint
-- 3. Point source-less and dangling articles at it. A dangling source_id (its
--    source row is gone) would otherwise survive the rebuild as an FK violation.
UPDATE articles SET source_id = (SELECT id FROM sources WHERE type = 'web_save')
  WHERE source_id IS NULL OR source_id NOT IN (SELECT id FROM sources);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer NOT NULL,
	`external_id` text,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`content_html` text,
	`content_text` text,
	`content_original_html` text,
	`original_file_path` text,
	`content_hash` text,
	`content_markdown` text,
	`ai_cleaned_at` text,
	`extraction_tier` text,
	`excerpt` text,
	`site_name` text,
	`image_url` text,
	`word_count` integer DEFAULT 0,
	`page_count` integer,
	`reading_progress` real DEFAULT 0,
	`reading_anchor_block` integer,
	`reading_anchor_offset` real,
	`status` text DEFAULT 'inbox' NOT NULL,
	`is_favorite` integer DEFAULT false,
	`ai_summary` text,
	`ai_tags` text,
	`ai_index` text,
	`tts_paragraph` integer,
	`tts_time_offset` real,
	`published_at` text,
	`saved_at` text DEFAULT (datetime('now')) NOT NULL,
	`read_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_articles`("id", "source_id", "external_id", "url", "title", "author", "content_html", "content_text", "content_original_html", "original_file_path", "content_hash", "content_markdown", "ai_cleaned_at", "extraction_tier", "excerpt", "site_name", "image_url", "word_count", "page_count", "reading_progress", "reading_anchor_block", "reading_anchor_offset", "status", "is_favorite", "ai_summary", "ai_tags", "ai_index", "tts_paragraph", "tts_time_offset", "published_at", "saved_at", "read_at", "created_at", "updated_at") SELECT "id", "source_id", "external_id", "url", "title", "author", "content_html", "content_text", "content_original_html", "original_file_path", "content_hash", "content_markdown", "ai_cleaned_at", "extraction_tier", "excerpt", "site_name", "image_url", "word_count", "page_count", "reading_progress", "reading_anchor_block", "reading_anchor_offset", "status", "is_favorite", "ai_summary", "ai_tags", "ai_index", "tts_paragraph", "tts_time_offset", "published_at", "saved_at", "read_at", "created_at", "updated_at" FROM `articles`;--> statement-breakpoint
DROP TABLE `articles`;--> statement-breakpoint
ALTER TABLE `__new_articles` RENAME TO `articles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `articles_external_id_unique` ON `articles` (`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `articles_url_unique` ON `articles` (`url`);--> statement-breakpoint
CREATE UNIQUE INDEX `articles_content_hash_unique` ON `articles` (`content_hash`);--> statement-breakpoint
CREATE INDEX `articles_status_idx` ON `articles` (`status`);--> statement-breakpoint
CREATE INDEX `articles_saved_at_idx` ON `articles` (`saved_at`);--> statement-breakpoint
CREATE INDEX `articles_source_idx` ON `articles` (`source_id`);--> statement-breakpoint
ALTER TABLE `sources` ADD `deleted_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `sources_singleton_type_idx` ON `sources` (`type`) WHERE type IN ('web_save','upload','readwise');