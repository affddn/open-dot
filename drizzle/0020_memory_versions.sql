ALTER TABLE `notes` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `notes` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `notes` ADD `updated_by` text DEFAULT 'dot' NOT NULL;--> statement-breakpoint
ALTER TABLE `reminders` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `reminders` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `reminders` ADD `updated_by` text DEFAULT 'dot' NOT NULL;--> statement-breakpoint
ALTER TABLE `responsibilities` ADD `version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `responsibilities` ADD `updated_by` text DEFAULT 'dot' NOT NULL;--> statement-breakpoint
CREATE TRIGGER `notes_version` AFTER UPDATE ON `notes` WHEN NEW.`version` = OLD.`version` BEGIN
	UPDATE `notes` SET `version` = OLD.`version` + 1, `updated_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), `updated_by` = 'dot' WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `responsibilities_version` AFTER UPDATE ON `responsibilities` WHEN NEW.`version` = OLD.`version` BEGIN
	UPDATE `responsibilities` SET `version` = OLD.`version` + 1, `updated_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), `updated_by` = 'dot' WHERE `id` = NEW.`id`;
END;--> statement-breakpoint
CREATE TRIGGER `reminders_version` AFTER UPDATE ON `reminders` WHEN NEW.`version` = OLD.`version` BEGIN
	UPDATE `reminders` SET `version` = OLD.`version` + 1, `updated_at` = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER), `updated_by` = 'scheduler' WHERE `id` = NEW.`id`;
END;
