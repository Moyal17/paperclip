/**
 * Route coverage for POST /api/plans/:issueId/complete.
 *
 * Marks a plan completed and attaches a generated retrospective document
 * (key "plan-retrospective") to the plan-root issue. Exercised against the
 * embedded Postgres harness so the subtree/approvals/cost joins + document
 * upsert + authz run on real SQL:
 *   - 200 with a retrospective covering tasks, gate decisions, developer notes,
 *     the per-agent cost table (+ total), and rejected gates as edge cases
 *   - second completion → 409 (idempotent guard)
 *   - completing with an existing unlocked retrospective updates it in place
 *   - 403 when an agent actor targets another company's plan
 */

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  activityLog,
  agents,
  approvalComments,
  approvals,
  companies,
  costEvents,
  createDb,
  documentRevisions,
  documents,
  issueComments,
  issueDocuments,
  issues,
  planDetails,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { planRoutes } from "../routes/plans.js";
import { planService } from "../services/plans.js";
import { issueService } from "../services/issues.js";
import { documentService } from "../services/documents.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres plan-complete tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("POST /api/plans/:issueId/complete", () => {
  let db!: ReturnType<typeof createDb>;
  let plans!: ReturnType<typeof planService>;
  let issuesSvc!: ReturnType<typeof issueService>;
  let docs!: ReturnType<typeof documentService>;
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

  function asAgentOf(companyId: string, agentId = randomUUID()) {
    actor = { type: "agent", companyId, agentId, runId: null };
  }

  async function seedCompany(prefix: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${prefix}`,
      issuePrefix: prefix,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string, name: string) {
    const id = randomUUID();
    await db.insert(agents).values({ id, companyId, name });
    return id;
  }

  // Build an active plan with a child task, two gate decisions (one approved,
  // one rejected), a gate comment, cost events for two agents, and a developer
  // comment. Returns the plan-root issue id.
  async function seedRichPlan(companyId: string) {
    const { issue: root } = await plans.createPlan(companyId, {
      title: "Pilot retrospective plan",
      gateProfile: "dev_team",
    });
    const child = await issuesSvc.create(companyId, {
      title: "Implement the complete endpoint",
      parentId: root.id,
    });
    await db.update(planDetails).set({ state: "active" }).where(eq(planDetails.issueId, root.id));

    const coder = await seedAgent(companyId, "Coder");
    const reviewer = await seedAgent(companyId, "Reviewer");

    const codeReviewId = randomUUID();
    const wiringId = randomUUID();
    await db.insert(approvals).values([
      {
        id: codeReviewId,
        companyId,
        type: "gate_code_review",
        status: "approved",
        payload: { planRootIssueId: root.id },
        decisionNote: "LGTM",
        decidedByAgentId: reviewer,
        decidedAt: new Date(),
      },
      {
        id: wiringId,
        companyId,
        type: "gate_wiring_review",
        status: "rejected",
        payload: { planRootIssueId: root.id },
        decisionNote: "Route not registered",
        decidedByAgentId: reviewer,
        decidedAt: new Date(),
      },
    ]);
    await db.insert(approvalComments).values({
      id: randomUUID(),
      companyId,
      approvalId: codeReviewId,
      authorAgentId: reviewer,
      body: "Checked the auth path",
    });

    await db.insert(costEvents).values([
      {
        id: randomUUID(),
        companyId,
        agentId: coder,
        issueId: child.id,
        provider: "anthropic",
        model: "claude-opus-4-8",
        inputTokens: 1000,
        cachedInputTokens: 100,
        outputTokens: 400,
        costCents: 250,
        occurredAt: new Date(),
      },
      {
        id: randomUUID(),
        companyId,
        agentId: reviewer,
        issueId: child.id,
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 300,
        cachedInputTokens: 0,
        outputTokens: 120,
        costCents: 80,
        occurredAt: new Date(),
      },
    ]);

    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId: child.id,
      authorAgentId: coder,
      authorType: "agent",
      body: "Implemented the route and added tests",
    });

    return { rootId: root.id, operatorId: coder };
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plan-complete-");
    db = createDb(tempDb.connectionString);
    plans = planService(db);
    issuesSvc = issueService(db);
    docs = documentService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(approvalComments);
    await db.delete(approvals);
    await db.delete(costEvents);
    await db.delete(issueComments);
    await db.delete(issueDocuments);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(planDetails);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
    actor = {};
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("completes a plan and attaches a retrospective with all sections", async () => {
    const companyId = await seedCompany("RET");
    const { rootId, operatorId } = await seedRichPlan(companyId);
    asAgentOf(companyId, operatorId);

    const res = await request(buildApp()).post(`/api/plans/${rootId}/complete`).send({});

    expect(res.status).toBe(200);
    expect(res.body.planDetails.state).toBe("completed");
    expect(res.body.planDetails.completedAt).toBeTruthy();

    const doc = res.body.retrospectiveDocument.document;
    expect(doc.key).toBe("plan-retrospective");
    const body: string = doc.body;
    // Task breakdown includes the child task.
    expect(body).toContain("Implement the complete endpoint");
    // Both gate decisions surface.
    expect(body).toContain("Code Review");
    expect(body).toContain("Wiring Review");
    // Developer note from issue_comments.
    expect(body).toContain("Implemented the route and added tests");
    // Per-agent cost table with both agents + a total row.
    expect(body).toContain("Coder");
    expect(body).toContain("Reviewer");
    expect(body).toContain("**Total**");
    // Rejected gate becomes an edge case with its reason.
    expect(body).toContain("Route not registered");

    // Persisted: the document is attached to the issue.
    const stored = await docs.getIssueDocumentByKey(rootId, "plan-retrospective");
    expect(stored).not.toBeNull();
  });

  it("returns 409 on a second completion", async () => {
    const companyId = await seedCompany("DUP");
    const { rootId, operatorId } = await seedRichPlan(companyId);
    asAgentOf(companyId, operatorId);

    const first = await request(buildApp()).post(`/api/plans/${rootId}/complete`).send({});
    expect(first.status).toBe(200);

    const second = await request(buildApp()).post(`/api/plans/${rootId}/complete`).send({});
    expect(second.status).toBe(409);
  });

  it("updates an existing unlocked retrospective in place", async () => {
    const companyId = await seedCompany("EXI");
    const { rootId, operatorId } = await seedRichPlan(companyId);
    // Pre-seed a retrospective document so completion must update, not create.
    await docs.upsertIssueDocument({
      issueId: rootId,
      key: "plan-retrospective",
      title: "Plan Retrospective",
      format: "markdown",
      body: "stale",
      createdByUserId: "seed",
    });
    asAgentOf(companyId, operatorId);

    const res = await request(buildApp()).post(`/api/plans/${rootId}/complete`).send({});
    expect(res.status).toBe(200);
    expect(res.body.retrospectiveDocument.created).toBe(false);
    expect(res.body.retrospectiveDocument.document.body).toContain("Plan Retrospective");
  });

  it("returns 403 when an agent targets another company's plan", async () => {
    const companyA = await seedCompany("AAA");
    const companyB = await seedCompany("BBB");
    const { rootId: rootB } = await seedRichPlan(companyB);
    asAgentOf(companyA);

    const res = await request(buildApp()).post(`/api/plans/${rootB}/complete`).send({});
    expect(res.status).toBe(403);
  });
});
