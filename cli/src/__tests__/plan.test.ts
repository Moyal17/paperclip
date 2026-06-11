import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerPlanCommands } from "../commands/client/plan.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "55555555-5555-4555-8555-555555555555";

function createProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({
    writeOut: () => {},
    writeErr: () => {},
  });
  registerPlanCommands(program);
  return program;
}

describe("plan create command", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_COMPANY_ID;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs /api/plans with a tier-1 task list and companyId in the body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ issue: { id: "plan-1", workMode: "planning" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync(
      [
        "plan", "create",
        "--api-base", "http://localhost:3100",
        "--api-key", "board-token",
        "--company-id", COMPANY_ID,
        "--title", "Build billing dashboard",
        "--overview", "Stripe + invoices",
        "--task", "Set up webhook",
        "--task", "Invoice list",
        "--token-cap", "500000",
        "--assignee-agent-id", AGENT_ID,
      ],
      { from: "user" },
    );

    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3100/api/plans");
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      companyId: COMPANY_ID,
      title: "Build billing dashboard",
      overview: "Stripe + invoices",
      tiers: [
        {
          id: "tier-1",
          kind: "phase",
          name: "Phase 1",
          requestedChildren: [{ title: "Set up webhook" }, { title: "Invoice list" }],
          childIssueIds: [],
        },
      ],
      budgetCapTokens: 500000,
      assigneeAgentId: AGENT_ID,
    });
  });

  it("omits tiers and nulls optional fields for an empty draft", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ issue: { id: "plan-2" } }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await createProgram().parseAsync(
      [
        "plan", "create",
        "--api-base", "http://localhost:3100",
        "--api-key", "board-token",
        "--company-id", COMPANY_ID,
        "--title", "Empty draft",
      ],
      { from: "user" },
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body.tiers).toBeUndefined();
    expect(body.title).toBe("Empty draft");
    expect(body.overview).toBeNull();
    expect(body.budgetCapTokens).toBeNull();
    expect(body.assigneeAgentId).toBeNull();
  });
});
