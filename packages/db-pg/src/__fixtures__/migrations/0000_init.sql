CREATE SCHEMA IF NOT EXISTS "fixture";
--> statement-breakpoint
CREATE TABLE "fixture"."widgets" ("id" serial PRIMARY KEY, "name" text NOT NULL);
