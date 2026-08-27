CREATE TABLE "pairing_tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"claimed_at" timestamp with time zone,
	"device_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pairing_tickets" ADD CONSTRAINT "pairing_tickets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pairing_tickets_code_hash_key" ON "pairing_tickets" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "pairing_tickets_user_idx" ON "pairing_tickets" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "pairing_tickets_expires_idx" ON "pairing_tickets" USING btree ("expires_at");