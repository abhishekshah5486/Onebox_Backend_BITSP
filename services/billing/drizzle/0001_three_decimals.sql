ALTER TABLE "billing"."accounts" ALTER COLUMN "balance" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "billing"."accounts" ALTER COLUMN "period_credits" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "billing"."ledger" ALTER COLUMN "credits" SET DATA TYPE numeric(14, 3);--> statement-breakpoint
ALTER TABLE "billing"."ledger" ALTER COLUMN "balance_after" SET DATA TYPE numeric(14, 3);