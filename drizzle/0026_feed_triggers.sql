CREATE TABLE `feed_triggers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dot` text NOT NULL,
	`responsibility` integer NOT NULL,
	`session_id` text NOT NULL,
	`source` text NOT NULL,
	`repository` text NOT NULL,
	`reasons` text NOT NULL,
	`task` text NOT NULL,
	`revision` text NOT NULL,
	`state` text NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`baseline_at` integer,
	`created_at` integer NOT NULL,
	`confirmed_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`responsibility`) REFERENCES `responsibilities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `trigger_occurrences` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trigger_id` integer NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`activity_at` integer NOT NULL,
	`epoch` integer NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`message_id` text,
	`event` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`trigger_id`) REFERENCES `feed_triggers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trigger_occurrences_message` ON `trigger_occurrences` (`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `trigger_occurrences_trigger_id_source_source_id_activity_at_unique` ON `trigger_occurrences` (`trigger_id`,`source`,`source_id`,`activity_at`);