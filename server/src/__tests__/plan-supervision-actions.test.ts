/**
 * Integration tests for POST /plans/:issueId/supervision/actions.
 *
 * Covers: input validation (400), plan not found (404), cross-company (403),
 * cross-company target agent/issue (400), and the stop_escalate path (writes
 * a supervision note + marks plan stopped).
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  planDetails,
  planSupervisionNotes,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { planRoutes } from "../routes/plans.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plan-supervision-actions tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /plans/:issueId/supervision/actions", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-supervision-actions-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(agentWakeupRequests);
    await db.delete(heartbeatRuns);
    await db.delete(planSupervisionNotes);
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ─── Seed helpers ────────────────────────────────────────────────────────────

  async function seedCompany() {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: `Co ${id.slice(0, 6)}`,
      issuePrefix: `T${id.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  async function seedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "TestAgent",
      role: "engineer",
      urlKey: `agent-${id.slice(0, 6)}`,
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return id;
  }

  async function seedPlan(companyId: string, state = "active") {
    const rootId = randomUUID();
    await db.insert(issues).values({
      id: rootId,
      companyId,
      title: "Test Plan",
      workMode: "planning",
      status: "in_progress",
    });
    await db.insert(planDetails).values({ issueId: rootId, companyId, state });
    return rootId;
  }

  async function seedIssue(companyId: string, parentId?: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Child Issue",
      workMode: "task",
      status: "in_progress",
      parentId: parentId ?? null,
    });
    return id;
  }

  async function seedHeartbeatRun(companyId: string, agentId: string) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({
      id,
      companyId,
      agentId,
      status: "running",
    });
    return id;
  }

  // ─── App builder ─────────────────────────────────────────────────────────────

  let actor: Record<string, unknown> = {};

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", planRoutes(db));
    app.use(errorHandler);
    return app;
  }

  function asBoardOf(companyId: string) {
    actor = { type: "board", userId: "test-user", companyId, source: "local_implicit" };
  }

  function asAgentOf(companyId: string) {
    actor = { type: "agent", companyId, agentId: randomUUID(), runId: null };
  }

  const ACTIONS_PATH = (id: string) => `/api/plans/${id}/supervision/actions`;

  // ─── Shared validation tests ─────────────────────────────────────────────────

  it("returns 400 for missing action field", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asBoardOf(companyId);

    const res = await request(buildApp())
      .post(ACTIONS_PATH(planId))
      .send({ targetAgentId: randomUUID() });

    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown action type", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asBoardOf(companyId);

    const res = await request(buildApp())
      .post(ACTIONS_PATH(planId))
      .send({ action: "nuke_it" });

    expect(res.status).toBe(400);
  });

  it("returns 404 for unknown plan", async () => {
    const companyId = await seedCompany();
    asBoardOf(companyId);

    const res = await request(buildApp())
      .post(ACTIONS_PATH(randomUUID()))
      .send({ action: "stop_escalate" });

    expect(res.status).toBe(404);
  });

  it("returns 403 for cross-company request", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const planId = await seedPlan(companyA);
    asAgentOf(companyB);

    const res = await request(buildApp())
      .post(ACTIONS_PATH(planId))
      .send({ action: "stop_escalate" });

    expect(res.status).toBe(403);
  });

  // ─── rewake ──────────────────────────────────────────────────────────────────

  describe("rewake", () => {
    it("returns 400 for missing targetAgentId", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId);
      asBoardOf(companyId);

      const res = await request(buildApp())
        .post(ACTIONS_PATH(planId))
        .send({ action: "rewake" });

      expect(res.status).toBe(400);
    });

    it("returns 400 when target agent belongs to different company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const planId = await seedPlan(companyA);
      const foreignAgentId = await seedAgent(companyB);
      asBoardOf(companyA);

      const res = await request(buildApp())
        .post(ACTIONS_PATH(planId))
        .send({ action: "rewake", targetAgentId: foreignAgentId });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/company/i);
    });

    it("returns 400 when target agent does not exist", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId);
      asBoardOf(companyId);

      const res = await request(buildApp())
        .post(ACTIONS_PATH(planId))
        .send({ action: "rewake", targetAgentId: randomUUID() });

      expect(res.status).toBe(400);
    });
  });

  // ─── cancel ──────────────────────────────────────────────────────────────────

  describe("cancel", () => {
    it("returns 400 for missing runId", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId);
      asBoardOf(companyId);

      const res = await request(buildApp())
        .post(ACTIONS_PATH(planId))
        .send({ action: "cancel" });

      expect(res.status).toBe(400);
    });

    it("returns 400 for non-uuid runId", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId);
      asBoardOf(companyId);

      const res = await request(buildApp())
        .post(ACTIONS_PATH(planId))
        .send({ action: "cancel", runId: "not-a-uuid" });

      expect(res.status).toBe(400);
    });

    it("returns 400 when runId belongs to a different company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const planId = await seedPlan(companyA);
      const agentB = await seedAgent(companyB);
      const runIdB = await seedHeartbeatRun(companyB, agentB);
      asBoardOf(companyA);

      const res = await request(buildApp())
        .post(ACTIONS_PATH(planId))
        .send({ action: "cancel", runId: runIdB });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/company/i);
    });
  });

  // ─── reassign ────────────────────────────────────────────────────────────────

  describe("reassign", () => {
    it("returns 400 for missing fields", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId);
      asBoardOf(companyId);

      const res = await request(buildApp())
        .post(ACTIONS_PATH(planId))
        .send({ action: "reassign", targetIssueId: randomUUID() });

      expect(res.status).toBe(400);
    });

    it("returns 400 when target issue belongs to different company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const planId = await seedPlan(companyA);
      const agentId = await seedAgent(companyA);
      const foreignIssueId = await seedIssue(companyB);
      asBoardOf(companyA);

      const res = await request(buildApp())
        .post(ACTIONS_PATH(planId))
        .send({ action: "reassign", targetIssueId: foreignIssueId, newAssigneeAgentId: agentId });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/company/i);
    });

    it("returns 400 when new assignee agent belongs to different company", async () => {
      const companyA = await seedCompany();
      const companyB = await seedCompany();
      const planId = await seedPlan(companyA);
      const issueId = await seedIssue(companyA);
      const foreignAgentId = await seedAgent(companyB);
      asBoardOf(companyA);

      const res = await request(buildApp())
        .post(ACTIONS_PATH(planId))
        .send({ action: "reassign", targetIssueId: issueId, newAssigneeAgentId: foreignAgentId });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/company/i);
    });
  });

  // ─── stop_escalate ───────────────────────────────────────────────────────────

  describe("stop_escalate", () => {
    it("marks the plan stopped and writes an action supervision note", async () => {
      const companyId = await seedCompany();
      const planId = await seedPlan(companyId, "active");
      asBoardOf(companyId);

      const res = await request(buildApp())
        .post(ACTIONS_PATH(planId))
        .send({ action: "stop_escalate", reason: "Escalating: plan is blocked" });

      expect(res.status).toBe(201);
      expect(res.body.actionTaken).toBe("stop_escalate");
      expect(res.body.note.kind).toBe("action");
      expect(res.body.note.actionTaken).toBe("stop_escalate");
      expect(res.body.note.body).toBe("Escalating: plan is blocked");

      // Verify plan_details state updated
      const [row] = await db
        .select({ state: planDetails.state })
        .from(planDetails)
        .where(eq(planDetails.issueId, planId));
      expect(row?.state).toBe("stopped");
    });
  });
});
