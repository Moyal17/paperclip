/**
 * Integration tests for GET /api/plans/:issueId/token-stats
 */

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import {
  agents,
  companies,
  costEvents,
  createDb,
  issues,
  planDetails,
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
    `Skipping plan-token-stats tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("GET /api/plans/:issueId/token-stats", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-token-stats-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(costEvents);
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

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

  async function seedAgent(companyId: string, name: string, role = "engineer") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role,
      urlKey: name.toLowerCase().replace(/\s+/g, "-") + "-" + agentId.slice(0, 4),
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 60, wakeOnDemand: true } },
      permissions: {},
    });
    return agentId;
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

  async function seedCostEvent(
    companyId: string,
    agentId: string,
    planIssueId: string,
    tokens: { input: number; cached: number; output: number; costCents: number },
  ) {
    await db.insert(costEvents).values({
      companyId,
      agentId,
      planIssueId,
      provider: "anthropic",
      biller: "anthropic",
      billingType: "subscription_included",
      model: "claude-opus-4-6",
      inputTokens: tokens.input,
      cachedInputTokens: tokens.cached,
      outputTokens: tokens.output,
      costCents: tokens.costCents,
      occurredAt: new Date(),
    });
  }

  it("returns empty stats for a plan with no cost events", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    asBoardOf(companyId);

    const res = await request(buildApp()).get(`/api/plans/${planId}/token-stats`);
    expect(res.status).toBe(200);
    expect(res.body.stats).toEqual([]);
  });

  it("returns aggregated token stats per agent", async () => {
    const companyId = await seedCompany();
    const planId = await seedPlan(companyId);
    const ctoId = await seedAgent(companyId, "CTO", "engineering-manager");
    const implId = await seedAgent(companyId, "Implementor", "engineer");

    await seedCostEvent(companyId, ctoId, planId, { input: 1000, cached: 200, output: 500, costCents: 150 });
    await seedCostEvent(companyId, ctoId, planId, { input: 800, cached: 100, output: 300, costCents: 100 });
    await seedCostEvent(companyId, implId, planId, { input: 500, cached: 0, output: 200, costCents: 70 });
    asBoardOf(companyId);

    const res = await request(buildApp()).get(`/api/plans/${planId}/token-stats`);
    expect(res.status).toBe(200);
    const stats = res.body.stats as Array<{
      agentId: string;
      agentName: string;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCostCents: number;
    }>;
    expect(stats).toHaveLength(2);

    const ctoRow = stats.find((s) => s.agentId === ctoId);
    expect(ctoRow).toBeDefined();
    expect(ctoRow!.agentName).toBe("CTO");
    expect(ctoRow!.totalInputTokens).toBe(1800);
    expect(ctoRow!.totalOutputTokens).toBe(800);
    expect(ctoRow!.totalCostCents).toBe(250);

    const implRow = stats.find((s) => s.agentId === implId);
    expect(implRow).toBeDefined();
    expect(implRow!.totalCostCents).toBe(70);
  });

  it("returns 404 for unknown plan", async () => {
    const companyId = await seedCompany();
    asBoardOf(companyId);
    const res = await request(buildApp()).get(`/api/plans/${randomUUID()}/token-stats`);
    expect(res.status).toBe(404);
  });

  it("excludes cost events from other plans", async () => {
    const companyId = await seedCompany();
    const planA = await seedPlan(companyId);
    const planB = await seedPlan(companyId);
    const agentId = await seedAgent(companyId, "Worker");

    await seedCostEvent(companyId, agentId, planA, { input: 100, cached: 0, output: 50, costCents: 20 });
    await seedCostEvent(companyId, agentId, planB, { input: 999, cached: 0, output: 999, costCents: 999 });
    asBoardOf(companyId);

    const res = await request(buildApp()).get(`/api/plans/${planA}/token-stats`);
    expect(res.status).toBe(200);
    expect(res.body.stats).toHaveLength(1);
    expect(res.body.stats[0].totalCostCents).toBe(20);
  });

  it("returns 403 for cross-company request", async () => {
    const companyA = await seedCompany();
    const companyB = await seedCompany();
    const planId = await seedPlan(companyA);
    actor = { type: "agent", companyId: companyB, agentId: randomUUID(), runId: null };

    const res = await request(buildApp()).get(`/api/plans/${planId}/token-stats`);
    expect(res.status).toBe(403);
  });
});
