ALTER TABLE `articles` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `sender_address` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `is_blocked` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_received_at` text;