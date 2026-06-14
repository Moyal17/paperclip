---
name: dev-roles
description: Manually run the Elite Engineering Team's role-switching workflow in a single context. Main Claude plays CTO → Architect → Implementor → Code Reviewer → Wiring Expert sequentially, announcing each role, enforcing the gate protocol, and keeping all artifacts in the transcript. Use when you want the team workflow on-demand rather than having it auto-trigger from CLAUDE.md, or when you want to run a partial subset of roles. Lightweight — no subagents, no team creation, no context isolation.
argument-hint: [roles] <task description> — e.g. "full add rate limiter", "plan-only refactor auth", "review src/auth/", "architect BullMQ vs SQS?"
allowed-tools: Read, Write, Edit, Bash, Grep, Glob, TaskCreate, TaskUpdate, TaskList, TaskGet
---

# Dev Roles — Role-Switching Workflow

You play every role of the Elite Engineering Team yourself, **in a single context**. No subagents, no team infrastructure. Announce each role switch clearly, obey each role's operating manual, and enforce the gate protocol.

This is the on-demand version of the workflow documented in the project's `CLAUDE.md`. Use it when you want the workflow **explicitly for this request** (especially in a project where CLAUDE.md doesn't already auto-activate it), or when you want to run a subset of roles.

## Canonical prompts

Read each role's prompt **lazily — just before the first time you announce that role**, not all up front. Partial modes then load only what they use (`architect-consult` reads one prompt, not six), and `full` mode defers reviewer prompts until after the plan gate. Once a prompt is read, don't re-read it on later switches back to that role.

- `~/sourceControl/claude-development-eco-system/teams/agent-team/prompts/cto.md`
- `~/sourceControl/claude-development-eco-system/teams/agent-team/prompts/architect.md`
- `~/sourceControl/claude-development-eco-system/teams/agent-team/prompts/implementor.md`
- `~/sourceControl/claude-development-eco-system/teams/agent-team/prompts/code_reviewer.md`
- `~/sourceControl/claude-development-eco-system/teams/agent-team/prompts/wiring_expert.md`
- `~/sourceControl/claude-development-eco-system/teams/agent-team/tasks/decomposition.md` (read at Step 2.1 only)

Obey every rule in the prompt for the role you are currently playing. Switch voice when you switch role.

---

## Step 1 — Parse the request

Read `ARGUMENTS`. Extract:
- **Mode** (optional, default `full`): `full` | `plan-only` | `review-only` | `architect-consult` | comma-separated subset (e.g. `architect,implementor`)
- **Task description**: everything after the mode keyword

Mode → roles played:

| Mode | Roles | Use when |
|---|---|---|
| `full` (default) | CTO → Architect → Implementor → Code Reviewer → Wiring Expert | Normal dev task |
| `plan-only` | CTO → Architect → Implementor (plan only) | Design / spec only — stop at approved plan |
| `review-only` | Code Reviewer + Wiring Expert on existing code | Audit an artifact the user points at |
| `architect-consult` | Architect only | One architectural question |
| custom subset | exactly the roles named | Power user override |

If the request is ambiguous, ask the user once before starting. Do not guess a mode.

---

## Step 2 — Execute the workflow

For the selected mode, run the steps below. Announce every role switch on its own line: `[CTO]`, `[ARCHITECT]`, `[IMPLEMENTOR]`, `[CODE REVIEWER]`, `[WIRING EXPERT]`.

### Step 2.1 — CTO: Decompose (skip for `review-only` and `architect-consult`)
Announce `[CTO]`. Decompose the user's request into discrete tasks following `tasks/decomposition.md`. For each task: id, title, description, acceptance criteria, scope boundaries. Output the task list as JSON.

### Step 2.2 — Implementor: Plan (skip for `review-only` and `architect-consult`)
Announce `[IMPLEMENTOR]`. Explore the relevant code using your read/search tools. Produce the structured JSON plan per the Implementor prompt's Phase 2 format (summary, files to modify/create, data flow, edge cases, test plan, dependencies, risk flags). **Do not write any code yet.**

### Step 2.3 — Architect: Review Plan (skip for `review-only`)
Announce `[ARCHITECT]`. Review against the criteria in the Architect prompt. Produce the structured JSON verdict: APPROVED or REJECTED with severity-tagged concerns.
- REJECTED → go back to Step 2.2 (new plan). Cap at 3 cycles before surfacing to user.
- APPROVED → proceed (for `plan-only`, jump to Step 3).

### Step 2.4 — Implementor: Build (skip for `plan-only`, `review-only`, `architect-consult`)
Announce `[IMPLEMENTOR]`. Implement exactly what the Architect approved — no scope creep. Write tests as you go. Run the project test suite before submitting. Cross-consult the Architect (announce `[ARCHITECT]` briefly mid-task, answer, switch back) for any ambiguity. Summarize files changed when done.

### Step 2.5 — Code Reviewer + Wiring Expert: Review (skip for `plan-only`, `architect-consult`)

Run **both reviews** before moving on. You can do them back-to-back in the same turn since you're one context — there's no real parallelism to exploit, but both must be completed.

Announce `[CODE REVIEWER]`. Review per the Code Reviewer prompt's dimensions (functionality, quality, tests, security, maintainability). Output the structured JSON verdict.

Announce `[WIRING EXPERT]`. Trace the feature end-to-end. Verify import completeness, entrypoint registration, dependency resolution, no dead code, no silent regressions. Output the structured JSON verdict **including the required `trace` block**.

### Step 2.6 — Evaluate gates (skip for `plan-only`, `architect-consult`)

- **Both reviewers APPROVED** → **TASK DONE**. Skip to Step 3.
- **Either rejected** → announce `[IMPLEMENTOR]`, address every blocking finding and every warning, then re-run only the rejecting reviewer's step (not the approving one). Cap at 3 rejection cycles before surfacing to user.

Before declaring DONE, the Implementor must resolve every `warning` and `suggestion` from the Architect and Wiring Expert (per Implementor Phase 5b), even if neither rejected.

---

## Step 3 — Final summary

Before the summary, emit the **task timing report** per the `task-timing` skill — one markdown table with task name, elapsed wall-clock, estimate vs actual. The `task-timing` skill auto-activates alongside this one whenever you drive the lifecycle through `TaskCreate`/`TaskUpdate`; obey its output rules. Skip it for `architect-consult` mode (no task lifecycle).

Then post a concise summary to the user:
- What was built / planned / reviewed
- Which gates passed (and in what cycle count)
- Any deferred warnings or TODOs
- Files touched (with paths)

---

## Mode-specific shortcuts

**`plan-only`**
Execute 2.1 → 2.2 → 2.3 until approved, then summary. Hand the approved plan to the user. Do not build.

**`review-only`**
Skip 2.1 through 2.4. Ask the user to confirm the exact files / diff to review if not already specified. Then execute 2.5 directly on the existing code.

**`architect-consult`**
Skip everything else. Announce `[ARCHITECT]`. Answer the question using the Architect manual's criteria, referencing specific files / patterns in the codebase. Keep it to one focused turn.

**Custom subset** (e.g. `architect,implementor`)
Execute only the steps that involve those roles. The gate protocol is still enforced for whatever gates are in scope — e.g. `architect,implementor` still requires plan approval before build, but no reviewer gates are run.

---

## Safety rules — non-negotiable

- **No code before plan approval.** If the task includes Implementor, Architect must approve first.
- **No TASK DONE while any in-scope gate is pending or rejected.**
- **No self-approval shortcuts.** Playing multiple roles in one context is not a license to rubber-stamp — apply each role's criteria honestly. If you catch yourself waving a plan through, stop and re-read the Architect manual.
- **Re-review only what was rejected.** On rejection, only the rejecting reviewer's check runs again, not both.
- **Rejection cap: 3 cycles.** After the third rejection of the same task, stop and surface to the user.

Canonical gate spec: `~/sourceControl/claude-development-eco-system/teams/agent-team/team.json` + role prompts — if this section ever conflicts with them, they win.

---

## When to pick this skill vs. the alternatives

| | `/dev-roles` *(this skill)* | `/run-dev-team` | Role-switching via project CLAUDE.md |
|---|---|---|---|
| Triggered by | Explicit `/dev-roles` call | Explicit `/run-dev-team` call | Automatic on any dev task in the project |
| Contexts | One (main) | Five (native team) | One (main) |
| Best for | On-demand workflow in projects that don't auto-activate it, or when you want a partial subset | Large tasks, real parallelism, isolated contexts | Default everyday work in TransVibe |

## Examples

```
/dev-roles full Add rate limiter to /api/upload (10 req/min/user)
/dev-roles plan-only Migrate auth middleware to express-jwt
/dev-roles review-only src/modules/credits/credits.service.ts
/dev-roles architect-consult Should flashcard retries use BullMQ or SQS?
/dev-roles architect,implementor Build the credit lock cleanup cron, skip reviewers
```
