CREATE TABLE `theses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer DEFAULT 1 NOT NULL,
	`title` text NOT NULL,
	`claim` text,
	`counterarguments` text,
	`implications` text,
	`status` text DEFAULT 'nascent' NOT NULL,
	`notes` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `thesis_highlights` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thesis_id` integer NOT NULL,
	`highlight_id` integer NOT NULL,
	`role` text DEFAULT 'supporting' NOT NULL,
	`note` text,
	`added_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`thesis_id`) REFERENCES `theses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`highlight_id`) REFERENCES `highlights`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thesis_highlights_unique` ON `thesis_highlights` (`thesis_id`,`highlight_id`);--> statement-breakpoint
CREATE TABLE `thesis_research` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thesis_id` integer NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`source` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`thesis_id`) REFERENCES `theses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `highlights` ADD `thesis_id` integer REFERENCES theses(id);