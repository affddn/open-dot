CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dot` text NOT NULL,
	`worker` integer NOT NULL,
	`session_id` text NOT NULL,
	`path` text NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`file` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`worker`) REFERENCES `workers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_file_unique` ON `artifacts` (`file`);--> statement-breakpoint
CREATE INDEX `artifacts_page` ON `artifacts` (`dot`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_origin` ON `artifacts` (`dot`,`worker`,`path`,`sha256`);