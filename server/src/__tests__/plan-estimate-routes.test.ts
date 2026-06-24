/**
 * Route integration tests for:
 *   PATCH /api/plans/:issueId/estimate  — set/clear plan ETA
 *   GET  /api/plans/:issueId/supervision/health — health diagnosis
 *
 * Uses embedded Postgres + supertest (same pattern as plans-list.test.ts).
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issues, planDetails } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { planRoutes } from "../routes/plans.js";
import { planService } from "../services/plans.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plan-estimate route tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("PATCH /plans/:issueId/estimate + GET /plans/:issueId/supervision/health", () => {
  let db!: ReturnType<typeof createDb>;
  let plans!: ReturnType<typeof planService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
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

  function asAgentOf(otherCompanyId: string) {
    actor = { type: "agent", companyId: otherCompanyId, agentId: randomUUID(), runId: null };
  }

  function asUnauthenticated() {
    actor = { type: "none", source: "none" };
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Co ${companyId.slice(0, 6)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 4).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedPlan(companyId: string) {
    const rootId = randomUUID();
    await db.insert(issues).values({
      id: rootId,
      companyId,
      title: "Test Plan",
      workMode: "planning",
      status: "in_progress",
    });
    await db.insert(planDetails).values({
      issueId: rootId,
      companyId,
      state: "active",
    });
    return rootId;
  }

  // An issue with NO plan_details sidecar — i.e. a regular issue, not a plan.
  async function seedNonPlanIssue(companyId: string) {
    const id = randomUUID();
    await db.insert(issues).values({
      id,
      companyId,
      title: "Regular Issue",
      workMode: "task",
      status: "in_progress",
    });
    return id;
  }

  async function seedAgent(companyId: string) {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: "Estimator",
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

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-estimate-routes-");
    db = createDb(tempDb.connectionString);
    plans = planService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(activityLog);
    await db.delete(companies);
    actor = {};
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // ─── PATCH /plans/:issueId/estimate ──────────────────────────────────────

  it("PATCH estimate 200 — sets estimatedCompletionAt and clears etaOverrunNotifiedAt", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    // Pre-stamp etaOverrunNotifiedAt to verify setEstimate clears it.
    await db
      .update(planDetails)
      .set({ etaOverrunNotifiedAt: new Date() })
      .where(eq(planDetails.issueId, planId));
    asBoardOf(companyId);

    const eta = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const res = await request(buildApp())
      .patch(`/api/plans/${planId}/estimate`)
      .send({ estimatedCompletionAt: eta });

    expect(res.status).toBe(200);
    expect(res.body.planDetails.estimatedCompletionAt).toBeTruthy();
    // setEstimate always nulls etaOverrunNotifiedAt so a reset ETA re-enables the wake.
    expect(res.body.planDetails.etaOverrunNotifiedAt).toBeNull();
  });

  it("PATCH estimate 200 — clears ETA when estimatedCompletionAt is null", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asBoardOf(companyId);

    // First set an ETA.
    await plans.setEstimate(planId, { estimatedCompletionAt: new Date(Date.now() + 3600_000) });

    const res = await request(buildApp())
      .patch(`/api/plans/${planId}/estimate`)
      .send({ estimatedCompletionAt: null, estimatorAgentId: null });

    expect(res.status).toBe(200);
    expect(res.body.planDetails.estimatedCompletionAt).toBeNull();
  });

  it("PATCH estimate 400 — invalid datetime string", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asBoardOf(companyId);

    const res = await request(buildApp())
      .patch(`/api/plans/${planId}/estimate`)
      .send({ estimatedCompletionAt: "not-a-date" });

    expect(res.status).toBe(400);
  });

  it("PATCH estimate 400 — empty body (refine: must provide at least one field)", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asBoardOf(companyId);

    const res = await request(buildApp())
      .patch(`/api/plans/${planId}/estimate`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("PATCH estimate 404 — unknown plan", async () => {
    const companyId = await seedCompany();
    asBoardOf(companyId);

    const res = await request(buildApp())
      .patch(`/api/plans/${randomUUID()}/estimate`)
      .send({ estimatedCompletionAt: new Date(Date.now() + 3600_000).toISOString() });

    expect(res.status).toBe(404);
  });

  it("PATCH estimate 404 — issue exists but is not a plan (no plan_details)", async () => {
    const companyId = await seedCompany();
    const issueId = await seedNonPlanIssue(companyId);
    asBoardOf(companyId);

    const res = await request(buildApp())
      .patch(`/api/plans/${issueId}/estimate`)
      .send({ estimatedCompletionAt: new Date(Date.now() + 3600_000).toISOString() });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not a plan/i);
  });

  it("PATCH estimate — estimatorAgentId-only update does NOT clear etaOverrunNotifiedAt", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    const agentId = await seedAgent(companyId);
    // Pre-stamp the one-shot overrun guard.
    const stamped = new Date(Date.now() - 60_000);
    await db
      .update(planDetails)
      .set({ etaOverrunNotifiedAt: stamped })
      .where(eq(planDetails.issueId, planId));
    asBoardOf(companyId);

    // Update only estimatorAgentId — ETA itself is untouched.
    const res = await request(buildApp())
      .patch(`/api/plans/${planId}/estimate`)
      .send({ estimatorAgentId: agentId });

    expect(res.status).toBe(200);
    // The guard must survive — re-arming it here would cause a spurious re-wake.
    expect(res.body.planDetails.etaOverrunNotifiedAt).not.toBeNull();
  });

  it("PATCH estimate 403 — cross-company agent", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asAgentOf(otherCompanyId);

    const res = await request(buildApp())
      .patch(`/api/plans/${planId}/estimate`)
      .send({ estimatedCompletionAt: new Date(Date.now() + 3600_000).toISOString() });

    expect(res.status).toBe(403);
  });

  it("PATCH estimate 401 — unauthenticated", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asUnauthenticated();

    const res = await request(buildApp())
      .patch(`/api/plans/${planId}/estimate`)
      .send({ estimatedCompletionAt: new Date(Date.now() + 3600_000).toISOString() });

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  // ─── GET /plans/:issueId/supervision/health ───────────────────────────────

  it("GET supervision/health 200 — returns health diagnosis shape", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asBoardOf(companyId);

    const res = await request(buildApp()).get(`/api/plans/${planId}/supervision/health`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("health");
    expect(res.body.health).toMatchObject({
      planIssueId: planId,
      overdue: false,
      agents: [],
    });
  });

  it("GET supervision/health 404 — unknown plan", async () => {
    const companyId = await seedCompany();
    asBoardOf(companyId);

    const res = await request(buildApp()).get(`/api/plans/${randomUUID()}/supervision/health`);

    expect(res.status).toBe(404);
  });

  it("GET supervision/health 404 — issue exists but is not a plan", async () => {
    const companyId = await seedCompany();
    const issueId = await seedNonPlanIssue(companyId);
    asBoardOf(companyId);

    const res = await request(buildApp()).get(`/api/plans/${issueId}/supervision/health`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not a plan/i);
  });

  it("GET supervision/health 403 — cross-company agent", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asAgentOf(otherCompanyId);

    const res = await request(buildApp()).get(`/api/plans/${planId}/supervision/health`);

    expect(res.status).toBe(403);
  });

  it("GET supervision/health 401 — unauthenticated", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asUnauthenticated();

    const res = await request(buildApp()).get(`/api/plans/${planId}/supervision/health`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });
});
