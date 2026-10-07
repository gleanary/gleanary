CREATE TABLE `ai_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`feature` text NOT NULL,
	`model` text NOT NULL,
	`status` text NOT NULL,
	`error_kind` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`web_search_count` integer DEFAULT 0 NOT NULL,
	`run_id` text,
	`resource_type` text,
	`resource_id` integer,
	`duration_ms` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_usage_created_idx` ON `ai_usage` (`created_at`);--> statement-breakpoint
CREATE INDEX `ai_usage_feature_idx` ON `ai_usage` (`feature`);--> statement-breakpoint
CREATE INDEX `ai_usage_run_idx` ON `ai_usage` (`run_id`);