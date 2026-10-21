CREATE TABLE `reactions` (
  `dot` text NOT NULL,
  `session_id` text NOT NULL,
  `message_id` text NOT NULL,
  `actor` text NOT NULL,
  `emoji` text,
  `excerpt` text NOT NULL,
  `updated_at` integer NOT NULL,
  PRIMARY KEY (`dot`, `session_id`, `message_id`, `actor`),
  FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
