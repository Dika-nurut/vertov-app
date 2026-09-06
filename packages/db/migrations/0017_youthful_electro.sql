CREATE TABLE "consent_records" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"document_slug" text NOT NULL,
	"document_version" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"ua" text
);
--> statement-breakpoint
CREATE INDEX "consent_records_user_id_idx" ON "consent_records" USING btree ("user_id");
