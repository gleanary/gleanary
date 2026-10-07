CREATE TABLE `voice_profile` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`profile` text DEFAULT '' NOT NULL,
	`extracted_at` text,
	`sample_count` integer DEFAULT 0 NOT NULL,
	`manual_edits_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `voice_profile_user_idx` ON `voice_profile` (`user_id`);--> statement-breakpoint
CREATE TABLE `voice_samples` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`profile_id` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`channel_hint` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `voice_profile`(`id`) ON UPDATE no action ON DELETE cascade
);
