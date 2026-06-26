ALTER TABLE "cost_events" ADD COLUMN "plan_issue_id" uuid REFERENCES "issues"("id") ON DELETE SET NULL;
CREATE INDEX "cost_events_company_plan_issue_idx" ON "cost_events" ("company_id","plan_issue_id");
