CREATE TABLE `articles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` integer,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`author` text,
	`content_html` text,
	`content_text` text,
	`excerpt` text,
	`site_name` text,
	`image_url` text,
	`word_count` integer DEFAULT 0,
	`reading_progress` real DEFAULT 0,
	`status` text DEFAULT 'inbox' NOT NULL,
	`is_favorite` integer DEFAULT false,
	`ai_summary` text,
	`ai_tags` text,
	`published_at` text,
	`saved_at` text DEFAULT (datetime('now')) NOT NULL,
	`read_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `articles_url_unique` ON `articles` (`url`);--> statement-breakpoint
CREATE TABLE `highlight_tags` (
	`highlight_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	FOREIGN KEY (`highlight_id`) REFERENCES `highlights`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `highlights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`article_id` integer NOT NULL,
	`text` text NOT NULL,
	`note` text,
	`color` text DEFAULT 'yellow' NOT NULL,
	`position_data` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_reviewed` text,
	`review_count` integer DEFAULT 0,
	`review_interval` integer DEFAULT 0,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`feed_url` text,
	`icon_url` text,
	`category` text,
	`poll_interval` integer DEFAULT 30,
	`last_polled` text,
	`etag` text,
	`last_modified` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);