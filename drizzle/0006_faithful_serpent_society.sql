ALTER TABLE `highlights` ADD `external_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `highlights_external_id_unique` ON `highlights` (`external_id`);