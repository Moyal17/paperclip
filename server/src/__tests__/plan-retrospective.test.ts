/**
 * Unit tests for the pure retrospective markdown renderer. No DB — exercises the
 * renderer contract: all seven sections, graceful empty-section handling, and the
 * per-agent cost roll-up (models merged per agent + a total row).
 */

import { describe, expect, it } from "vitest";
import {
  renderRetrospectiveMarkdown,
  type RetrospectiveData,
} from "../services/plan-retrospective.js";

function baseData(overrides: Partial<RetrospectiveData> = {}): RetrospectiveData {
  return {
    title: "Pilot plan",
    gateProfile: "dev_team",
    state: "completed",
    activatedAt: new Date("2026-06-01T00:00:00.000Z"),
    completedAt: new Date("2026-06-02T00:00:00.000Z"),
    tasks: [],
    gates: [],
    devNotes: [],
    critique: null,
    costs: [],
    edgeCases: [],
    ...overrides,
  };
}

describe("renderRetrospectiveMarkdown", () => {
  it("renders all seven sections with 'None recorded' when empty", () => {
    const md = renderRetrospectiveMarkdown(baseData());
    expect(md).toContain("# Plan Retrospective — Pilot plan");
    for (const heading of [
      "## Executive Overview",
      "## Task Breakdown",
      "## Gate Reviews",
      "## Developer / Implementor Notes",
      "## Critique & Completeness Review",
      "## Token Usage & Cost per Agent",
      "## Edge Cases Found & Reasons",
    ]) {
      expect(md).toContain(heading);
    }
    // Empty sections degrade gracefully.
    expect((md.match(/None recorded\./g) ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it("renders the task breakdown table", () => {
    const md = renderRetrospectiveMarkdown(
      baseData({
        tasks: [
          { id: "i1", identifier: "PAP-1", title: "Root", status: "done", assigneeName: "CTO" },
          { id: "i2", identifier: "PAP-2", title: "Child", status: "in_progress", assigneeName: null },
        ],
      }),
    );
    expect(md).toContain("| PAP-1 | Root | done | CTO |");
    expect(md).toContain("| PAP-2 | Child | in_progress | — |");
    expect(md).toContain("Tasks:** 2");
  });

  it("rolls models up per agent and emits a total row", () => {
    const md = renderRetrospectiveMarkdown(
      baseData({
        costs: [
          { agentId: "a1", agentName: "Coder", model: "claude-opus-4-8", inputTokens: 100, cachedInputTokens: 10, outputTokens: 50, costCents: 250 },
          { agentId: "a1", agentName: "Coder", model: "claude-sonnet-4-6", inputTokens: 200, cachedInputTokens: 20, outputTokens: 80, costCents: 150 },
          { agentId: "a2", agentName: "Reviewer", model: "claude-sonnet-4-6", inputTokens: 60, cachedInputTokens: 0, outputTokens: 30, costCents: 100 },
        ],
      }),
    );
    // Agent a1's two models merge into one row (input 300, cost $4.00).
    expect(md).toMatch(/\| Coder \| claude-opus-4-8, claude-sonnet-4-6 \| 300 \| 30 \| 130 \| \$4\.00 \|/);
    expect(md).toContain("| Reviewer | claude-sonnet-4-6 | 60 | 0 | 30 | $1.00 |");
    // Total row sums everything: input 360, cost $5.00.
    expect(md).toMatch(/\| \*\*Total\*\* \| \| 360 \| 30 \| 160 \| \*\*\$5\.00\*\* \|/);
  });

  it("lists rejected gates as edge cases and separates the critique", () => {
    const md = renderRetrospectiveMarkdown(
      baseData({
        gates: [
          {
            type: "gate_wiring_review",
            label: "Wiring Review",
            status: "rejected",
            decisionNote: "Route not registered",
            deciderName: "Wiring Expert",
            decidedAt: new Date("2026-06-01T12:00:00.000Z"),
            comments: [],
          },
        ],
        critique: {
          type: "gate_completeness_review",
          label: "Completeness Critic",
          status: "approved",
          decisionNote: "Looks complete",
          deciderName: "Critic",
          decidedAt: null,
          comments: [{ authorName: "Critic", body: "Edge case X covered", createdAt: null }],
        },
        edgeCases: [{ gateLabel: "Wiring Review", reason: "Route not registered" }],
      }),
    );
    expect(md).toContain("### Wiring Review — rejected");
    expect(md).toContain("- **Wiring Review**: Route not registered");
    // Critique is its own section, not under Gate Reviews.
    expect(md).toContain("**Completeness Critic — approved**");
    expect(md).toContain("Edge case X covered");
  });

  it("renders developer notes from comments", () => {
    const md = renderRetrospectiveMarkdown(
      baseData({
        devNotes: [
          { issueIdentifier: "PAP-2", authorName: "Coder", authorRole: "engineer", body: "Implemented the route", createdAt: null },
        ],
      }),
    );
    expect(md).toContain("- **Coder, engineer** (PAP-2): Implemented the route");
  });
});
