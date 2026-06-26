CREATE TABLE "plan_supervision_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"plan_issue_id" uuid NOT NULL,
	"author_agent_id" uuid,
	"author_user_id" text,
	"kind" text NOT NULL,
	"target_agent_id" uuid,
	"target_issue_id" uuid,
	"severity" text DEFAULT 'info' NOT NULL,
	"body" text NOT NULL,
	"health_snapshot" jsonb,
	"action_taken" text,
	"created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_supervision_notes" ADD CONSTRAINT "plan_supervision_notes_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_supervision_notes" ADD CONSTRAINT "plan_supervision_notes_plan_issue_id_plan_details_issue_id_fk" FOREIGN KEY ("plan_issue_id") REFERENCES "public"."plan_details"("issue_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_supervision_notes" ADD CONSTRAINT "plan_supervision_notes_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_supervision_notes" ADD CONSTRAINT "plan_supervision_notes_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "plan_supervision_notes" ADD CONSTRAINT "plan_supervision_notes_target_issue_id_issues_id_fk" FOREIGN KEY ("target_issue_id") REFERENCES "public"."issues"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "plan_supervision_notes_company_idx" ON "plan_supervision_notes" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "plan_supervision_notes_plan_created_idx" ON "plan_supervision_notes" USING btree ("plan_issue_id","created_at" DESC);
--> statement-breakpoint
ALTER TABLE "plan_details" ADD COLUMN "last_monitored_at" timestamptz;
