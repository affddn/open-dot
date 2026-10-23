CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dot` text NOT NULL,
	`source` text NOT NULL,
	`worker` integer,
	`session_id` text NOT NULL,
	`title` text NOT NULL,
	`directory` text NOT NULL,
	`kind` text NOT NULL,
	`request_id` text NOT NULL,
	`detail` text NOT NULL,
	`sensitive` integer DEFAULT false NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`answer` text,
	`actor_session` text,
	`created_at` integer NOT NULL,
	`gone_at` integer,
	`queued_at` integer,
	`attempted_at` integer,
	`confirmed_at` integer,
	`escalated_at` integer,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `requests_session_id_kind_request_id_unique` ON `requests` (`session_id`,`kind`,`request_id`);