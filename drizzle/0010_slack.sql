CREATE TABLE `slack` (
	`ts` text PRIMARY KEY NOT NULL,
	`dot` text NOT NULL,
	`message_id` text NOT NULL,
	`reply_id` text,
	`reply_text` text,
	`reply_ts` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
