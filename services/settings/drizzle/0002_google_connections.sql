CREATE TABLE "settings"."google_connections" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"refresh_token_encrypted" text NOT NULL,
	"scopes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
