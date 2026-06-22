import { pgTable, uuid, text, jsonb, index, timestamp } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { issues } from "./issues.js";
import { planDetails } from "./plan_details.js";

export const planSupervisionNotes = pgTable(
  "plan_supervision_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    planIssueId: uuid("plan_issue_id").notNull().references(() => planDetails.issueId, { onDelete: "cascade" }),
    authorAgentId: uuid("author_agent_id").references(() => agents.id, { onDelete: "set null" }),
    authorUserId: text("author_user_id"),
    // 'observation' | 'overrun' | 'action'
    kind: text("kind").notNull(),
    targetAgentId: uuid("target_agent_id").references(() => agents.id, { onDelete: "set null" }),
    targetIssueId: uuid("target_issue_id").references(() => issues.id, { onDelete: "set null" }),
    // 'info' | 'warning' | 'critical'
    severity: text("severity").notNull().default("info"),
    body: text("body").notNull(),
    healthSnapshot: jsonb("health_snapshot"),
    // Phase 3: rewake | cancel | reassign | stop | escalate
    actionTaken: text("action_taken"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdx: index("plan_supervision_notes_company_idx").on(table.companyId),
    planCreatedIdx: index("plan_supervision_notes_plan_created_idx").on(table.planIssueId, table.createdAt),
  }),
);
