CREATE TABLE `ledger` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dot` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`topic` text NOT NULL,
	`text` text NOT NULL,
	`priority` integer NOT NULL,
	`valid_from` integer NOT NULL,
	`superseded_by` integer,
	`sources` text NOT NULL,
	`job` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `ledger_state` (
	`dot` text PRIMARY KEY NOT NULL,
	`epoch` integer DEFAULT 0 NOT NULL,
	`observed_through` integer DEFAULT 0 NOT NULL,
	`observed_offset` integer DEFAULT 0 NOT NULL,
	`head_job` integer,
	`stopped_day` integer,
	`head_session` text,
	`head_compaction` text,
	`head_text` text,
	`head_at` integer,
	`head_rows` text,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `observer_jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dot` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`native` integer DEFAULT false NOT NULL,
	`complete` integer DEFAULT true NOT NULL,
	`from_id` integer DEFAULT 0 NOT NULL,
	`from_offset` integer DEFAULT 0 NOT NULL,
	`to_id` integer DEFAULT 0 NOT NULL,
	`to_offset` integer DEFAULT 0 NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`epoch` integer NOT NULL,
	`model` text,
	`scratch_session` text,
	`prompt_message` text,
	`estimate` integer DEFAULT 0 NOT NULL,
	`used` integer,
	`cached` integer,
	`charged` integer,
	`charged_at` integer,
	`error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `observer_jobs_dot_session_id_kind_trigger_unique` ON `observer_jobs` (`dot`,`session_id`,`kind`,`trigger`);--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `observer` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `ledger` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `frozen_head` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `rank_notes` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `observer_model` text;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `observer_daily_tokens` integer DEFAULT 50000 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_settings` ADD `generation` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE VIRTUAL TABLE `ledger_fts` USING fts5(`text`, `dot` UNINDEXED, tokenize = 'trigram remove_diacritics 1');--> statement-breakpoint
INSERT INTO `ledger_fts` (`rowid`, `text`, `dot`) SELECT `id`, `topic` || ' ' || `text`, `dot` FROM `ledger`;--> statement-breakpoint
CREATE TRIGGER `fts_ledger_insert` AFTER INSERT ON `ledger` BEGIN
	INSERT INTO `ledger_fts` (`rowid`, `text`, `dot`) VALUES (NEW.`id`, NEW.`topic` || ' ' || NEW.`text`, NEW.`dot`);
END;--> statement-breakpoint
CREATE TRIGGER `fts_ledger_update` AFTER UPDATE OF `id`, `topic`, `text`, `dot` ON `ledger` BEGIN
	DELETE FROM `ledger_fts` WHERE `rowid` = OLD.`id`;
	INSERT INTO `ledger_fts` (`rowid`, `text`, `dot`) VALUES (NEW.`id`, NEW.`topic` || ' ' || NEW.`text`, NEW.`dot`);
END;--> statement-breakpoint
CREATE TRIGGER `fts_ledger_delete` AFTER DELETE ON `ledger` BEGIN
	DELETE FROM `ledger_fts` WHERE `rowid` = OLD.`id`;
END;
