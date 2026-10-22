ALTER TABLE `reminders` ADD `route` text;
--> statement-breakpoint
ALTER TABLE `workers` ADD `route` text;
--> statement-breakpoint
ALTER TABLE `outbox` ADD `route` text;
--> statement-breakpoint
ALTER TABLE `outbox` ADD `quote` text;
--> statement-breakpoint
ALTER TABLE `outbox` ADD `owner_text` text;
--> statement-breakpoint
ALTER TABLE `outbox` ADD `started_at` integer;
--> statement-breakpoint
ALTER TABLE `outbox` ADD `turn_end` text;
--> statement-breakpoint
UPDATE `outbox` SET `started_at` = `created_at` WHERE `state` = 'sent';
--> statement-breakpoint
ALTER TABLE `slack` ADD `route` text;
--> statement-breakpoint
ALTER TABLE `slack_events` ADD `route` text;
--> statement-breakpoint
CREATE TABLE `slack_threads` (
  `key` text PRIMARY KEY NOT NULL,
  `route` text NOT NULL,
  `parent` text,
  `oldest` text NOT NULL,
  `newest` text NOT NULL,
  `cursor` text DEFAULT '' NOT NULL,
  `rescan` integer DEFAULT false NOT NULL,
  `active_at` integer NOT NULL,
  `polled_at` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slack_polls` (
  `key` text PRIMARY KEY NOT NULL,
  `oldest` text NOT NULL,
  `newest` text NOT NULL,
  `cursor` text DEFAULT '' NOT NULL
);
