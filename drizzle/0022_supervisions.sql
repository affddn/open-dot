CREATE TABLE `supervisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dot` text NOT NULL,
	`session_id` text NOT NULL,
	`directory` text NOT NULL,
	`mode` text NOT NULL,
	`state` text NOT NULL,
	`end_reason` text,
	`busy_minutes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`activated_at` integer,
	`ended_at` integer,
	`seen_at` integer,
	`seen_ids` text DEFAULT '[]' NOT NULL,
	`waiting_on` text DEFAULT '[]' NOT NULL,
	`busy_since` integer,
	`busy_reported` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supervisions_open` ON `supervisions` (`dot`,`session_id`) WHERE `state` != 'ended';--> statement-breakpoint
ALTER TABLE `outbox` ADD `supervision` integer;