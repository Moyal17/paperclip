ALTER TABLE "plan_details" ADD COLUMN IF NOT EXISTS "gate_profile" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "decided_by_agent_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approvals" ADD CONSTRAINT "approvals_decided_by_agent_id_agents_id_fk" FOREIGN KEY ("decided_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
