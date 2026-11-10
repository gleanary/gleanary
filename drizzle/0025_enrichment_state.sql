CREATE TABLE `ai_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`anthropic_batch_id` text NOT NULL,
	`purpose` text DEFAULT 'article_enrich' NOT NULL,
	`status` text NOT NULL,
	`request_count` integer NOT NULL,
	`succeeded_count` integer,
	`errored_count` integer,
	`submitted_at` text DEFAULT (datetime('now')) NOT NULL,
	`ended_at` text,
	`processed_at` text,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_batches_anthropic_batch_id_unique` ON `ai_batches` (`anthropic_batch_id`);--> statement-breakpoint
CREATE INDEX `ai_batches_status_idx` ON `ai_batches` (`status`);--> statement-breakpoint
ALTER TABLE `articles` ADD `enrich_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` ADD `enrich_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` ADD `enriched_at` text;--> statement-breakpoint
ALTER TABLE `articles` ADD `enrich_truncated` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `articles` ADD `enrich_batch_id` integer;--> statement-breakpoint
CREATE INDEX `articles_enrich_status_idx` ON `articles` (`enrich_status`);--> statement-breakpoint
-- Hand-added (docs/modules/article-enrichment.md §4.2): legacy rows with a summary are
-- already enriched. They become `done` with enriched_at NULL, even when ai_tags or
-- ai_index is missing; the backfill can target them with scope 'legacy'.
UPDATE articles SET enrich_status = 'done' WHERE ai_summary IS NOT NULL AND trim(ai_summary) != '';
