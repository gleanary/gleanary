CREATE INDEX `articles_status_idx` ON `articles` (`status`);--> statement-breakpoint
CREATE INDEX `articles_saved_at_idx` ON `articles` (`saved_at`);--> statement-breakpoint
CREATE INDEX `articles_source_idx` ON `articles` (`source_id`);--> statement-breakpoint
CREATE INDEX `chat_messages_session_idx` ON `chat_messages` (`session_id`);--> statement-breakpoint
DELETE FROM `highlight_tags` WHERE rowid NOT IN (SELECT MIN(rowid) FROM `highlight_tags` GROUP BY `highlight_id`, `tag_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `highlight_tags_unique` ON `highlight_tags` (`highlight_id`,`tag_id`);--> statement-breakpoint
CREATE INDEX `highlight_tags_tag_idx` ON `highlight_tags` (`tag_id`);--> statement-breakpoint
CREATE INDEX `highlights_article_idx` ON `highlights` (`article_id`);--> statement-breakpoint
CREATE INDEX `highlights_last_reviewed_idx` ON `highlights` (`last_reviewed`);--> statement-breakpoint
CREATE INDEX `highlights_review_interval_idx` ON `highlights` (`review_interval`);--> statement-breakpoint
CREATE INDEX `thesis_research_thesis_idx` ON `thesis_research` (`thesis_id`);--> statement-breakpoint
CREATE INDEX `voice_samples_profile_idx` ON `voice_samples` (`profile_id`);