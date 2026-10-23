ALTER TABLE `slack_apps` ADD `prompts` text;--> statement-breakpoint
ALTER TABLE `slack_apps` ADD `manifest_version` integer;--> statement-breakpoint
ALTER TABLE `slack_apps` ADD `update_state` text;--> statement-breakpoint
ALTER TABLE `slack_apps` ADD `update_at` integer;--> statement-breakpoint
ALTER TABLE `slack_apps` ADD `update_note` text;--> statement-breakpoint
ALTER TABLE `slack_events` ADD `status_at` integer;--> statement-breakpoint
ALTER TABLE `slack_events` ADD `stream` text;--> statement-breakpoint
ALTER TABLE `slack_events` ADD `stream_id` text;--> statement-breakpoint
ALTER TABLE `slack_events` ADD `stream_ts` text;--> statement-breakpoint
ALTER TABLE `slack_events` ADD `stream_text` text;--> statement-breakpoint
ALTER TABLE `slack_events` ADD `title` text;--> statement-breakpoint
-- Threads from before titles never get one, so an old conversation's name isn't replaced.
UPDATE `slack_events` SET `title` = '' WHERE `kind` = 'dm';