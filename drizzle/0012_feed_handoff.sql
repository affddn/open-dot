ALTER TABLE `feed` ADD `handed_to` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `outbox` ADD `feed` text;