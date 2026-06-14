import { Command } from "commander";
import {
  addCommonClientOptions,
  apiPath,
  type BaseClientOptions,
  handleCommandError,
  printOutput,
  resolveCommandContext,
} from "./common.js";

interface PlanCreateOptions extends BaseClientOptions {
  companyId?: string;
  title: string;
  overview?: string;
  task?: string[];
  tokenCap?: string;
  assigneeAgentId?: string;
  gateProfile?: string;
  project?: string;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function registerPlanCommands(program: Command): void {
  const plan = program.command("plan").description("MyHive plan operations");

  addCommonClientOptions(
    plan
      .command("create")
      .description(
        "Create a MyHive plan (draft) that appears in the board's Plans column. Provide tasks with repeated --task. The plan lands as a draft; click Activate on the board to start work (Activate is blocked until at least one task exists).",
      )
      .requiredOption("-C, --company-id <id>", "Company ID")
      .requiredOption("--title <title>", "Plan title")
      .option("--overview <text>", "Plan overview/description")
      .option("--task <title>", "Tier-1 task title (repeatable)", collect, [])
      .option("--token-cap <n>", "Token budget cap for the plan")
      .option("--assignee-agent-id <id>", "Agent to assign the plan to")
      .option(
        "--gate-profile <profile>",
        "Gate protocol: none (default), solo (no gates, no PR), light (1 code-review gate), or dev_team (full advisory dev-team gates)",
      )
      .option(
        "--project <id>",
        "Project the plan and its issues belong to (worktree + git-ops resolve through it)",
      )
      .action(async (opts: PlanCreateOptions) => {
        try {
          const ctx = resolveCommandContext(opts, { requireCompany: true });
          const tasks = opts.task ?? [];
          const tiers = tasks.length
            ? [
                {
                  id: "tier-1",
                  kind: "phase" as const,
                  name: "Phase 1",
                  requestedChildren: tasks.map((title) => ({ title })),
                  childIssueIds: [] as string[],
                },
              ]
            : undefined;
          const tokenCap = opts.tokenCap !== undefined ? Number.parseInt(opts.tokenCap, 10) : null;
          if (tokenCap !== null && Number.isNaN(tokenCap)) {
            throw new Error("--token-cap must be an integer");
          }
          const validGateProfiles = ["none", "solo", "light", "dev_team"];
          if (opts.gateProfile !== undefined && !validGateProfiles.includes(opts.gateProfile)) {
            throw new Error("--gate-profile must be 'none', 'solo', 'light', or 'dev_team'");
          }
          const payload = {
            companyId: ctx.companyId,
            title: opts.title,
            overview: opts.overview ?? null,
            tiers,
            budgetCapTokens: tokenCap,
            assigneeAgentId: opts.assigneeAgentId ?? null,
            ...(opts.gateProfile ? { gateProfile: opts.gateProfile } : {}),
            ...(opts.project ? { projectId: opts.project } : {}),
          };
          const created = await ctx.api.post(apiPath`/api/plans`, payload);
          // Confirmation to stderr so it shows even in --json mode — a successful
          // create must not be mistaken for a failure (avoids duplicate plans).
          const createdIssue = (created as { issue?: { identifier?: string; id?: string } })?.issue;
          if (createdIssue?.id) {
            console.error(
              `Plan ${createdIssue.identifier ?? createdIssue.id} created (draft) — activate to start.`,
            );
          }
          printOutput(created, { json: ctx.json });
        } catch (err) {
          handleCommandError(err);
        }
      }),
    { includeCompany: false },
  );
}
