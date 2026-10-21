CREATE TABLE `feed` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`reason` text NOT NULL,
	`title` text NOT NULL,
	`context` text NOT NULL,
	`url` text,
	`updated_at` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `feed_source_source_id_unique` ON `feed` (`source`,`source_id`);