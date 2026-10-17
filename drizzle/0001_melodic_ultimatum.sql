CREATE TABLE `charges` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text NOT NULL,
	`status` text NOT NULL,
	`finix_transfer_id` text,
	`attempt_no` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`subscription_id`) REFERENCES `subscriptions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `payment_instruments` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`finix_instrument_id` text NOT NULL,
	`finix_identity_id` text NOT NULL,
	`last4` text,
	`brand` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payment_instruments_user_id_unique` ON `payment_instruments` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_instruments_finix_instrument_id_unique` ON `payment_instruments` (`finix_instrument_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`provider` text DEFAULT 'stripe' NOT NULL,
	`type` text NOT NULL,
	`processed_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_webhook_events`("id", "event_id", "type", "processed_at") SELECT "stripe_event_id", "stripe_event_id", "type", "processed_at" FROM `webhook_events`;--> statement-breakpoint
DROP TABLE `webhook_events`;--> statement-breakpoint
ALTER TABLE `__new_webhook_events` RENAME TO `webhook_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_webhook_events_event_provider` ON `webhook_events` (`event_id`,`provider`);--> statement-breakpoint
CREATE TABLE `__new_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`provider` text DEFAULT 'stripe' NOT NULL,
	`stripe_subscription_id` text,
	`stripe_price_id` text,
	`finix_identity_id` text,
	`plan_id` text,
	`status` text NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`current_period_end` integer,
	`cancel_at_period_end` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_subscriptions`("id", "user_id", "stripe_subscription_id", "stripe_price_id", "status", "current_period_end", "cancel_at_period_end", "created_at", "updated_at") SELECT "id", "user_id", "stripe_subscription_id", "stripe_price_id", "status", "current_period_end", "cancel_at_period_end", "created_at", "updated_at" FROM `subscriptions`;--> statement-breakpoint
DROP TABLE `subscriptions`;--> statement-breakpoint
ALTER TABLE `__new_subscriptions` RENAME TO `subscriptions`;--> statement-breakpoint
CREATE UNIQUE INDEX `subscriptions_stripe_subscription_id_unique` ON `subscriptions` (`stripe_subscription_id`);--> statement-breakpoint
ALTER TABLE `users` ADD `finix_identity_id` text;