ALTER TABLE `responsibilities` ADD `schedule` text;--> statement-breakpoint
ALTER TABLE `responsibilities` ADD `next_run_at` integer;--> statement-breakpoint
CREATE TRIGGER `responsibilities_pause` AFTER UPDATE OF `status` ON `responsibilities` WHEN NEW.`status` != 'active' AND NEW.`next_run_at` IS NOT NULL BEGIN
	UPDATE `responsibilities` SET `next_run_at` = NULL WHERE `id` = NEW.`id`;
END;
