CREATE TABLE `slack_apps` (
	`dot` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`attempt_id` text,
	`app_id` text,
	`team_id` text,
	`owner_id` text,
	`bot_id` text,
	`bot_user` text,
	`problem` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `slack_config` (
	`id` integer PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`from_iat` integer,
	`problem` text,
	`notices_since` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slack_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`app` text NOT NULL,
	`dot` text NOT NULL,
	`kind` text NOT NULL,
	`event_id` text,
	`channel` text,
	`ts` text,
	`thread` text,
	`user` text,
	`text` text,
	`context_ts` text,
	`message_id` text,
	`reply_id` text,
	`reply_text` text,
	`reply_ts` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_events_app_event_id_unique` ON `slack_events` (`app`,`event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `slack_events_app_channel_ts_unique` ON `slack_events` (`app`,`channel`,`ts`);--> statement-breakpoint
CREATE TABLE `slack_notices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bot` text NOT NULL,
	`channel` text NOT NULL,
	`user` text NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slack_notices_bot_channel_user_unique` ON `slack_notices` (`bot`,`channel`,`user`);