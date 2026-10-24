CREATE TABLE `archive` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`dot` text NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text NOT NULL,
	`role` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`archived_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `archive_dot_session_id_message_id_unique` ON `archive` (`dot`,`session_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `archive_cursors` (
	`dot` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`cursor` text,
	`anchor` text,
	`pending` text DEFAULT '[]' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`checked_at` integer,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `memory_settings` (
	`dot` text PRIMARY KEY NOT NULL,
	`archive` integer DEFAULT false NOT NULL,
	`backfill` integer DEFAULT false NOT NULL,
	`archive_since` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`dot`) REFERENCES `dots`(`name`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE VIRTUAL TABLE `memory_fts` USING fts5(`text`, `dot` UNINDEXED, `session` UNINDEXED, tokenize = 'trigram remove_diacritics 1');--> statement-breakpoint
INSERT INTO `memory_fts` (`rowid`, `text`, `dot`, `session`) SELECT -`id`, `text`, `dot`, NULL FROM `notes`;--> statement-breakpoint
CREATE TRIGGER `fts_notes_insert` AFTER INSERT ON `notes` BEGIN
	INSERT INTO `memory_fts` (`rowid`, `text`, `dot`, `session`) VALUES (-NEW.`id`, NEW.`text`, NEW.`dot`, NULL);
END;--> statement-breakpoint
CREATE TRIGGER `fts_notes_update` AFTER UPDATE OF `id`, `text`, `dot` ON `notes` BEGIN
	DELETE FROM `memory_fts` WHERE `rowid` = -OLD.`id`;
	INSERT INTO `memory_fts` (`rowid`, `text`, `dot`, `session`) VALUES (-NEW.`id`, NEW.`text`, NEW.`dot`, NULL);
END;--> statement-breakpoint
CREATE TRIGGER `fts_notes_delete` AFTER DELETE ON `notes` BEGIN
	DELETE FROM `memory_fts` WHERE `rowid` = -OLD.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `fts_archive_insert` AFTER INSERT ON `archive` BEGIN
	INSERT INTO `memory_fts` (`rowid`, `text`, `dot`, `session`) VALUES (NEW.`id`, NEW.`text`, NEW.`dot`, NEW.`session_id`);
END;--> statement-breakpoint
CREATE TRIGGER `fts_archive_delete` AFTER DELETE ON `archive` BEGIN
	DELETE FROM `memory_fts` WHERE `rowid` = OLD.`id`;
END;
--> statement-breakpoint
CREATE TRIGGER `fts_archive_update` AFTER UPDATE OF `id`, `text`, `dot`, `session_id` ON `archive` BEGIN
	DELETE FROM `memory_fts` WHERE `rowid` = OLD.`id`;
	INSERT INTO `memory_fts` (`rowid`, `text`, `dot`, `session`) VALUES (NEW.`id`, NEW.`text`, NEW.`dot`, NEW.`session_id`);
END;
