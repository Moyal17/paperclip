# MyHive Dev-Team Factory — Overview & Testing Guide

Consolidated state of the dev-team factory built on `feat/myhive-board`.
Running build log: `claude-docs/phase-log.md`. Plan of record:
`~/.claude/plans/i-want-you-to-calm-eagle.md`.

---

## 1. What this is

A personal dev factory inside Paperclip. The Hive (a company of agents) does the
engineering: an issue assigned to the team is decomposed, planned, implemented in
an isolated git worktree, pushed to **your fork** as a GitHub PR, and reviewed
through dev-team gates — with cost + an audit trail attached and a hard budget
guard against runaway token burn. The only human act is **merge**.

**North star:** issue in → gate-reviewed fork PR out, cost + audit attached,
human = merge.

**Hard rule (security):** the factory only ever pushes to the **Moyal17 fork**.
Upstream (`paperclipai/paperclip`) push is **disabled** and must stay disabled.
The GitHub token is fork-scoped and is **never** exposed to an agent.

---

## 2. What we built (by area)

### Gates — the dev-team review protocol (A1)
- A plan carries a `gate_profile` of `none` (default) or `dev_team`.
- Activating a `dev_team` plan materializes advisory gate approvals as rows in
  the `approvals` table: one `gate_plan_approval` on the plan root → **Architect**,
  and per leaf a `gate_code_review` → **Code Reviewer** + `gate_wiring_review` →
  **Wiring Expert**. Designated agent resolved by urlKey; missing role falls back
  to the board owner (never blocks activation).
- Agents decide their own gate via `POST /approvals/:id/agent-decide` (agent-only,
  must be the designated agent, gate_* types only).
- **Soft** today: nothing is blocked. Hard-block is a later phase (C1).
- Blocked-inbox classifier surfaces `pending_plan_approval` / `pending_code_review`
  / `pending_wiring_review` with the right owner and plan>code>wiring precedence.

### Worktrees (A2)
- The existing `git_worktree` execution-workspace machinery realizes a worktree
  per issue at run time. Branch convention + isolation are **project config**
  (`executionWorkspacePolicy`), not new code. On terminal status a dev_team
  issue's worktree is flagged for cleanup (branches never auto-deleted).

### GitHub PR pipeline (A3 + A6)
- `issues.pr_url` column + a PR chip on the issue (A3).
- **A6 git-ops proxy** replaced the original (forbidden) env-bound token design.
  "Commit local, ship by tool": agents commit in their worktree credential-free,
  then call two MCP tools — `paperclipPushBranch`, `paperclipOpenPullRequest` —
  that hit agent-only endpoints `POST /issues/:id/git/{push,pr}`. The server
  resolves the fork token from a company secret and does the push + PR; the token
  never enters the agent's env, argv, or worktree.

### Gate audit ledger UI (A4)
- `GateLedger` on the issue: each gate, verdict, responsible agent, decided-at,
  decision note — read from the issue's gate_* approval rows.
- `PlanGateRollup` in the plan drawer: plan-approval verdict + code/wiring
  passed/total.

### Cost + budget (A5 + E6)
- Per-issue cost widget (tokens in/out/cached, $, runtime) + company/plan budget
  meter on the board.
- **E6**: dev_team activation auto-installs an issue-scoped, **lifetime,
  hard-stop** budget policy on the plan root from the plan's cap. It aggregates
  over the whole subtree, so one policy bounds total burn — the runaway guard.
- **A5 cap setter**: `PATCH /plans/:id/budget` persists the cap and, for a
  dev_team plan, **re-syncs the hard-stop policy in place**, so a cap edited
  after activation enforces live. Wired into the plan drawer's Save action.

### Model tiering (E4)
- `modelProfile` override on a wake threads into the heartbeat context, so
  mechanical reviewer/implementor stages can run on the **cheap** tier. Which
  agents/stages use cheap is per-agent `runtimeConfig` (operator config).

### Lean tooling + comms (E1/E2)
- `scripts/lean-{test,typecheck,lint}` print failures-only (vendored skill).
- Caveman inter-agent comms standard in all six dev-team `AGENTS.md` (operator-
  local / gitignored).

---

## 3. Security posture (git-ops) — what actually protects the token

The token is a **capability handed to the server, never to the agent**.

- Resolved from a company secret inside `git-ops.ts` with **no binding context**,
  so it is server-internal and never bound to an agent env var.
- `runHardenedGitPush` is the **only** place a credentialed push runs. The token
  lives only in that subprocess's env.
- Inline credential helper releases the token **only for the exact expected host**
  (checks git's stdin) → a malicious `url.insteadOf` redirect fails closed; the
  token is never sent off-host.
- Command-line `credential.helper=` reset clears any agent-written repo-config
  helper; `core.hooksPath` → empty dir so no agent pre-push hook runs with the
  token; global/system git config nulled.
- Output is sanitized to `{code,status,exitCode}` — raw git/GitHub output is
  logged server-side only, never returned to the agent.
- Authz: actor must be an agent **and** the issue's assignee. Agents supply only
  PR title/body/draft — repo, remote, branch, base are all derived server-side.

**Residual (documented, accepted):** local same-user execution is a soft boundary
(`/proc/<pid>/environ` during the brief push). The hard boundary is a sandboxed
execution target — future hardening, not required for a personal fork-scoped run.

---

## 4. What changed in the codebase (entry points)

| Area | Path |
|---|---|
| Gate profile + agent-decide | `server/src/services/plans.ts`, `routes/approvals.ts`, `services/plan-gates.ts` |
| Git-ops proxy | `server/src/services/git-ops.ts`, `routes/git-ops.ts` |
| Git-ops MCP tools | `packages/mcp-server/src/tools.ts` (`paperclipPushBranch`, `paperclipOpenPullRequest`) |
| Sandbox allowlist | `packages/adapter-utils/src/sandbox-callback-bridge.ts` |
| Budget guard + cap setter | `server/src/services/plans.ts` (`createActivationBudgetPolicies`, `setBudgetCaps`), `routes/plans.ts` (`PATCH /plans/:id/budget`) |
| Model tiering | `packages/shared/src/validators/agent.ts` (`wakeAgentSchema.modelProfile`), `server/src/routes/agents.ts` |
| Gate ledger UI | `ui/src/components/hive/GateLedger.tsx`, `PlanGateRollup.tsx`, `lib/gates.ts` |
| Cost / budget UI | `ui/src/pages/IssueDetail.tsx` (cost), `components/hive/BudgetMeterWidget.tsx`, `PlanDetailDrawer.tsx` |

Config schema (no migration): `projects.executionWorkspacePolicy.gitOps =
{ remoteUrl, baseBranch, tokenSecretName }`.

---

## 5. What to remember for testing (B1 pilot)

### Code state
- The factory PR loop + gates + cost/budget + runaway guard + model tiering are
  **code-complete**. Nothing more to build for a first run.
- All gates passed cycle 1; typecheck clean; unit suites green. **Real git /
  GitHub execution is NOT exercised by unit tests by design** — the credential
  helper, push, and PR creation are validated for the first time in this pilot.

### Operator setup required before a run (no code)
1. **Rebuild mcp-server** so agents see the two new tools:
   `pnpm --filter @paperclipai/mcp-server build`.
2. **Hive project config** — set `executionWorkspacePolicy`:
   - `defaultMode: isolated_workspace`, `workspaceStrategy.type: git_worktree`,
     `branchTemplate: "issue/{{issue.identifier}}-{{slug}}"`
   - `gitOps: { remoteUrl: "https://github.com/Moyal17/paperclip.git",
     baseBranch: "master", tokenSecretName: "github-fork-pat" }`
   - project points at a local paperclip clone path.
3. **Fork-scoped GitHub PAT** stored as a **company secret** (provider
   `local_encrypted`), name = `github-fork-pat`. `repo` + pull-request scope,
   **no upstream access**, short expiry, rotate. NEVER env-bound.
4. **Staff the gate agents** with urlKeys `architect` / `code-reviewer` /
   `wiring-expert` (so gates route to them, not the board fallback), plus an
   implementor assignee.
5. **Implementor `AGENTS.md`** (local): call `paperclipOpenPullRequest` /
   `paperclipPushBranch` instead of `gh` / manual PATCH.
6. **Set a plan budget cap** so E6 installs the runaway guard before any
   unattended run.

### First pilot — keep it small
- One small, low-blast-radius issue (a docs task or a tiny line-item).
- Watch for, and log to `claude-docs/pilot-log.md`:
  - Does the worktree realize with branch `issue/<id>-<slug>`?
  - Do gates appear on the right issues with the right designated agents?
  - Does `paperclipOpenPullRequest` actually push + open a PR on the fork? (First
    real exercise of the credential helper / push / PR path.)
  - Is the PR URL stored on the issue + shown as the chip?
  - Do reviewers decide their gates via `/agent-decide`?
  - Does the cost widget show burn; does the budget cap hard-stop if exceeded?
  - Any token leakage in agent-visible output/logs (should be none).
- Fix the top deviations before a second run.

### Known limitations to validate, not assume
- `dangerouslySkipPermissions: true` means agents run Bash unprompted — the
  defense is fork-scope + the server-side token, not agent restraint.
- Cap **removal** (setting a cap to null after activation) does not auto-deactivate
  an already-installed policy; manage via the budget UI if needed.
- Hard-block gates (C1) are not in yet — gates are advisory; an agent could mark
  an issue done with a pending gate. Acceptable for the pilot (observe protocol-
  following first).

---

## 6. Status

- Phase A (A1–A6) + Track E (E1/E2/E4/E6) — **done**.
- Open on the fork: PR #1 (`feat/myhive-board → master`, fork-internal).
- Next: **B1 pilot** (operator setup above), then B2/B3 (inbox, digest),
  C1–C3 (hard gates, calibration, drift check), E5 (repo index).
