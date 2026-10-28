ALTER TABLE `requests` ADD `notice_id` text;--> statement-breakpoint
ALTER TABLE `requests` ADD `noticed_at` integer;--> statement-breakpoint
ALTER TABLE `workers` ADD `paths` text;--> statement-breakpoint
UPDATE `requests` SET `noticed_at` = `created_at`;