CREATE TABLE `hidden_messages` (
	`dot` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`hidden_at` integer NOT NULL,
	PRIMARY KEY(`dot`, `session_id`, `message_id`),
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
