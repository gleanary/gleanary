ALTER TABLE `ai_usage` ADD `pages_processed` integer;
--> statement-breakpoint
UPDATE `articles` SET `extraction_tier` = 'mistral' WHERE `extraction_tier` = 'claude';