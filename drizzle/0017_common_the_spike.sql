ALTER TABLE `articles` ADD `content_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `articles_content_hash_unique` ON `articles` (`content_hash`);