import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueComments, issues } from "@paperclipai/db";
import { GATE_APPROVAL_TYPES } from "@paperclipai/shared";
import { planService } from "./plans.js";
import { approvalService } from "./approvals.js";
import { costService } from "./costs.js";

// Human label per gate approval type. Unknown types fall back to the raw value.
const GATE_LABELS: Record<string, string> = {
  [GATE_APPROVAL_TYPES.planApproval]: "Architect — Plan Approval",
  [GATE_APPROVAL_TYPES.codeReview]: "Code Review",
  [GATE_APPROVAL_TYPES.wiringReview]: "Wiring Review",
  [GATE_APPROVAL_TYPES.completenessReview]: "Completeness Critic",
};

function gateLabel(type: string): string {
  return GATE_LABELS[type] ?? type;
}

export interface RetrospectiveGate {
  type: string;
  label: string;
  status: string;
  decisionNote: string | null;
  deciderName: string | null;
  decidedAt: Date | null;
  comments: Array<{ authorName: string | null; body: string; createdAt: Date | null }>;
}

export interface RetrospectiveTask {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeName: string | null;
}

export interface RetrospectiveDevNote {
  issueIdentifier: string | null;
  authorName: string | null;
  authorRole: string | null;
  body: string;
  createdAt: Date | null;
}

export interface RetrospectiveCostRow {
  agentId: string | null;
  agentName: string | null;
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costCents: number;
}

export interface RetrospectiveEdgeCase {
  gateLabel: string;
  reason: string;
}

export interface RetrospectiveData {
  title: string;
  gateProfile: string;
  state: string;
  activatedAt: Date | null;
  completedAt: Date | null;
  tasks: RetrospectiveTask[];
  gates: RetrospectiveGate[];
  devNotes: RetrospectiveDevNote[];
  critique: RetrospectiveGate | null;
  costs: RetrospectiveCostRow[];
  edgeCases: RetrospectiveEdgeCase[];
}

export function planRetrospectiveService(db: Db) {
  const plans = planService(db);
  const approvals = approvalService(db);
  const costs = costService(db);

  // Gather all retrospective inputs for a completed (or about-to-be-completed)
  // plan. Read-only — safe to call before the state flip. completedAt is the
  // timestamp the caller intends to stamp on the plan, so the document reflects
  // it even though the row is updated afterwards.
  async function gather(planRootIssueId: string, completedAt: Date): Promise<RetrospectiveData> {
    const plan = await plans.getPlan(planRootIssueId);
    if (!plan) throw new Error(`Plan not found for issue ${planRootIssueId}`);
    const { issue, planDetails } = plan;
    const companyId = issue.companyId;

    const subtreeIds = await plans.subtreeIssueIds(planRootIssueId);

    // Tasks = every issue in the subtree (root included), with assignee name.
    const taskRows = subtreeIds.length
      ? await db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            assigneeName: agents.name,
          })
          .from(issues)
          .leftJoin(agents, eq(issues.assigneeAgentId, agents.id))
          .where(inArray(issues.id, subtreeIds))
      : [];
    const tasks: RetrospectiveTask[] = taskRows.map((row) => ({
      id: row.id,
      identifier: row.identifier ?? null,
      title: row.title,
      status: row.status,
      assigneeName: row.assigneeName ?? null,
    }));

    // Agent id -> name map for resolving gate deciders.
    const companyAgents = await db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(eq(agents.companyId, companyId));
    const agentNameById = new Map(companyAgents.map((a) => [a.id, a.name]));

    // Gates: every approval scoped to this plan, plus its comments.
    const approvalRows = await approvals.list(companyId, undefined, planRootIssueId);
    const gates: RetrospectiveGate[] = [];
    for (const approval of approvalRows) {
      const comments = await approvals.listComments(approval.id);
      gates.push({
        type: approval.type,
        label: gateLabel(approval.type),
        status: approval.status,
        decisionNote: approval.decisionNote ?? null,
        deciderName: approval.decidedByAgentId
          ? agentNameById.get(approval.decidedByAgentId) ?? null
          : approval.decidedByUserId ?? null,
        decidedAt: approval.decidedAt ?? null,
        comments: comments.map((c) => ({
          authorName: c.authorAgentId
            ? agentNameById.get(c.authorAgentId) ?? null
            : c.authorUserId ?? null,
          body: c.body,
          createdAt: c.createdAt ?? null,
        })),
      });
    }
    const critique =
      gates.find((g) => g.type === GATE_APPROVAL_TYPES.completenessReview) ?? null;

    // Developer / implementor notes: free-text issue comments across the subtree,
    // skipping soft-deleted and system-authored rows.
    const commentRows = subtreeIds.length
      ? await db
          .select({
            issueIdentifier: issues.identifier,
            authorAgentId: issueComments.authorAgentId,
            authorUserId: issueComments.authorUserId,
            authorType: issueComments.authorType,
            authorName: agents.name,
            authorRole: agents.role,
            body: issueComments.body,
            createdAt: issueComments.createdAt,
          })
          .from(issueComments)
          .leftJoin(agents, eq(issueComments.authorAgentId, agents.id))
          .innerJoin(issues, eq(issueComments.issueId, issues.id))
          .where(and(inArray(issueComments.issueId, subtreeIds), isNull(issueComments.deletedAt)))
          .orderBy(asc(issueComments.createdAt))
      : [];
    const devNotes: RetrospectiveDevNote[] = commentRows
      .filter((row) => row.authorType !== "system")
      .map((row) => ({
        issueIdentifier: row.issueIdentifier ?? null,
        authorName: row.authorName ?? row.authorUserId ?? null,
        authorRole: row.authorRole ?? null,
        body: row.body,
        createdAt: row.createdAt ?? null,
      }));

    // Per-agent token + cost over the subtree.
    const costs_ = await costs.perAgentForIssues(companyId, subtreeIds);

    // Edge cases found = gates whose terminal status is rejected (gate, reason).
    const edgeCases: RetrospectiveEdgeCase[] = gates
      .filter((g) => g.status === "rejected")
      .map((g) => ({ gateLabel: g.label, reason: g.decisionNote ?? "(no reason recorded)" }));

    return {
      title: issue.title,
      gateProfile: planDetails.gateProfile,
      state: planDetails.state,
      activatedAt: planDetails.activatedAt ?? null,
      completedAt,
      tasks,
      gates,
      devNotes,
      critique,
      costs: costs_,
      edgeCases,
    };
  }

  return { gather };
}

// ─── Pure markdown renderer (no DB) ──────────────────────────────────────────

function fmtDate(d: Date | null): string {
  return d ? d.toISOString() : "—";
}

function centsToUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function statusRollup(tasks: RetrospectiveTask[]): string {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  return [...counts.entries()].map(([s, n]) => `${s}: ${n}`).join(", ") || "none";
}

export function renderRetrospectiveMarkdown(data: RetrospectiveData): string {
  const lines: string[] = [];
  lines.push(`# Plan Retrospective — ${data.title}`, "");

  // 1. Executive overview
  lines.push("## Executive Overview", "");
  lines.push(`- **Gate profile:** ${data.gateProfile}`);
  lines.push(`- **Completed at:** ${fmtDate(data.completedAt)}`);
  lines.push(`- **Activated at:** ${fmtDate(data.activatedAt)}`);
  lines.push(`- **Tasks:** ${data.tasks.length} (${statusRollup(data.tasks)})`, "");

  // 2. Task breakdown
  lines.push("## Task Breakdown", "");
  if (data.tasks.length === 0) {
    lines.push("None recorded.", "");
  } else {
    lines.push("| Identifier | Title | Status | Assignee |", "| --- | --- | --- | --- |");
    for (const t of data.tasks) {
      lines.push(`| ${t.identifier ?? "—"} | ${t.title} | ${t.status} | ${t.assigneeName ?? "—"} |`);
    }
    lines.push("");
  }

  // 3. Gate reviews
  lines.push("## Gate Reviews", "");
  const reviewGates = data.gates.filter((g) => g.type !== GATE_APPROVAL_TYPES.completenessReview);
  if (reviewGates.length === 0) {
    lines.push("None recorded.", "");
  } else {
    for (const g of reviewGates) {
      lines.push(`### ${g.label} — ${g.status}`);
      lines.push(`- Decider: ${g.deciderName ?? "—"} · ${fmtDate(g.decidedAt)}`);
      if (g.decisionNote) lines.push(`- Decision: ${g.decisionNote}`);
      for (const c of g.comments) {
        lines.push(`  - _${c.authorName ?? "unknown"}_: ${c.body}`);
      }
      lines.push("");
    }
  }

  // 4. Developer / implementor notes
  lines.push("## Developer / Implementor Notes", "");
  if (data.devNotes.length === 0) {
    lines.push("None recorded.", "");
  } else {
    for (const n of data.devNotes) {
      const who = [n.authorName ?? "unknown", n.authorRole].filter(Boolean).join(", ");
      lines.push(`- **${who}** (${n.issueIdentifier ?? "—"}): ${n.body}`);
    }
    lines.push("");
  }

  // 5. Critique & completeness review
  lines.push("## Critique & Completeness Review", "");
  if (!data.critique) {
    lines.push("None recorded.", "");
  } else {
    lines.push(`**${data.critique.label} — ${data.critique.status}**`);
    if (data.critique.decisionNote) lines.push(`- Decision: ${data.critique.decisionNote}`);
    for (const c of data.critique.comments) {
      lines.push(`- _${c.authorName ?? "unknown"}_: ${c.body}`);
    }
    lines.push("");
  }

  // 6. Token usage & cost per agent (models rolled up per agent, with total)
  lines.push("## Token Usage & Cost per Agent", "");
  if (data.costs.length === 0) {
    lines.push("None recorded.", "");
  } else {
    type Agg = {
      agentName: string | null;
      models: Set<string>;
      input: number;
      cached: number;
      output: number;
      cents: number;
    };
    const byAgent = new Map<string, Agg>();
    let totalInput = 0;
    let totalCached = 0;
    let totalOutput = 0;
    let totalCents = 0;
    for (const row of data.costs) {
      const key = row.agentId ?? "unknown";
      const agg =
        byAgent.get(key) ??
        { agentName: row.agentName, models: new Set<string>(), input: 0, cached: 0, output: 0, cents: 0 };
      if (row.model) agg.models.add(row.model);
      agg.input += row.inputTokens;
      agg.cached += row.cachedInputTokens;
      agg.output += row.outputTokens;
      agg.cents += row.costCents;
      byAgent.set(key, agg);
      totalInput += row.inputTokens;
      totalCached += row.cachedInputTokens;
      totalOutput += row.outputTokens;
      totalCents += row.costCents;
    }
    lines.push(
      "| Agent | Model(s) | Input | Cached | Output | Cost |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const agg of byAgent.values()) {
      const models = [...agg.models].join(", ") || "—";
      lines.push(
        `| ${agg.agentName ?? "unknown"} | ${models} | ${agg.input} | ${agg.cached} | ${agg.output} | ${centsToUsd(agg.cents)} |`,
      );
    }
    lines.push(
      `| **Total** | | ${totalInput} | ${totalCached} | ${totalOutput} | **${centsToUsd(totalCents)}** |`,
      "",
    );
  }

  // 7. Edge cases found & reasons
  lines.push("## Edge Cases Found & Reasons", "");
  if (data.edgeCases.length === 0) {
    lines.push("None recorded.", "");
  } else {
    for (const e of data.edgeCases) {
      lines.push(`- **${e.gateLabel}**: ${e.reason}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
