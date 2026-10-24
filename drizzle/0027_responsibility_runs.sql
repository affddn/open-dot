CREATE TABLE `responsibility_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dot` text NOT NULL,
	`responsibility` integer NOT NULL,
	`due_at` integer NOT NULL,
	`claimed_at` integer NOT NULL,
	`snapshot` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`turn` text,
	`observed_at` integer,
	`waiting` integer DEFAULT false NOT NULL,
	`outcome` text,
	`error` text,
	`turn_end` text,
	`ended_at` integer,
	`attribution` text,
	`result_id` text,
	`result_text` text,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`responsibility`) REFERENCES `responsibilities`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `responsibility_runs_message_id_unique` ON `responsibility_runs` (`message_id`);--> statement-breakpoint
CREATE INDEX `responsibility_runs_page` ON `responsibility_runs` (`dot`,`responsibility`,`id`);--> statement-breakpoint
CREATE TABLE `run_workers` (
	`worker` integer PRIMARY KEY NOT NULL,
	`run` integer NOT NULL,
	`assistant_message` text NOT NULL,
	FOREIGN KEY (`worker`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run`) REFERENCES `responsibility_runs`(`id`) ON UPDATE no action ON DELETE no action
);
