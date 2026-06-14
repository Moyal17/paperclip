---
name: task-timing
description: Stamp start/end timestamps on every TaskCreate/TaskUpdate transition in the dev-team workflow (Architect → Implementor → Code Reviewer → Wiring Expert) and emit a mini timing report when all tasks close. Auto-fires whenever a task lifecycle is being driven by /dev-roles, /run-dev-team, /feature, or /quick-fix — anything that uses TaskCreate/TaskUpdate to track gate progress. Reports task name, total elapsed wall-clock, and estimate vs actual when an approved plan exists.
allowed-tools: TaskCreate, TaskUpdate, TaskList, TaskGet, Read, Write
---

# Task Timing — wall-clock report for the dev team workflow

You wrap the team's existing task lifecycle with timestamping so the user gets a small report at the end showing how long each task actually took. This is non-invasive: it does not change gate logic, role prompts, or decomposition. It only **records times** and **prints a summary**.

## When this fires

This skill is active whenever you are running the gate workflow through `TaskCreate`/`TaskUpdate` — specifically:

- `/dev-roles` (any mode)
- `/run-dev-team`
- `/feature` Phase E (build + review)
- `/quick-fix` (the compressed loop)
- Any project where role-switching is auto-activated by `CLAUDE.md` and you are using `TaskCreate`/`TaskUpdate` to track gates

If the workflow is *not* using `TaskCreate`/`TaskUpdate` (e.g. a tiny one-off edit), do nothing.

## What to record

For each task, keep an in-memory log entry. You do **not** need to persist this to disk unless the user asks — keep it in the conversation context as a single markdown table you update as the workflow progresses.

Entry shape:

```
task_id | title | started_at | ended_at | elapsed | estimate_hours | actual_hours | result
```

- `started_at` — ISO timestamp of the moment the task is created (TaskCreate call)
- `ended_at` — ISO timestamp of the moment the CTO marks the task `TASK_DONE` (the final TaskUpdate that closes it after both gates approved)
- `elapsed` — `ended_at - started_at` rendered as `Xh Ym` or `Xm Ys`
- `estimate_hours` — pulled from the approved plan if one exists (Implementor Phase 2 plan, or `/feature` Phase C plan file frontmatter). If no estimate is on record, write `—`
- `actual_hours` — `elapsed` rendered as decimal hours to one place (e.g. `0.4h`, `1.7h`)
- `result` — `done` | `abandoned` | `escalated` (after 3 rejection cycles)

## How to capture timestamps

Use the system clock — get the current time at the moment of each TaskCreate / final TaskUpdate. The `date -u +%Y-%m-%dT%H:%M:%SZ` shell command is fine if you need to materialize one; otherwise use the timestamp the harness exposes when you run the tool.

Concretely:

1. **On TaskCreate:** capture `now()` and store it under `started_at` for that task id. Also capture the estimate if the plan exposes one (e.g. plan JSON `estimated_hours`, or plan-file frontmatter `estimated_hours`).
2. **On the final TaskUpdate that sets status to `TASK_DONE`** (i.e. both gates approved, no warnings outstanding): capture `now()` as `ended_at`. Compute elapsed.
3. **On rejection cycles:** do NOT reset timing. The clock keeps running across all rejection rounds — the user wants total wall-clock per task, not just the successful round.
4. **On escalation (3 rejection cycles → surfaced to user):** stamp `ended_at` and `result: escalated`. The clock stops.

## When to emit the report

Print the report **once**, at the very end of the workflow, after every task is in a terminal state (`done` / `abandoned` / `escalated`). For `/dev-roles full`, this is right before your final summary in Step 3. For `/feature`, this is right before the Phase G handoff. For `/quick-fix`, this is right before the merge-ready summary.

## Report format

Keep it small. Markdown table only — no preamble, no postamble.

```
### Task timing

| Task | Elapsed | Estimate | Actual | Status |
|---|---|---|---|---|
| T1: Add rate limiter to /api/upload | 38m | 1.0h | 0.6h | ✓ done |
| T2: Wire limiter into auth middleware | 1h 12m | 0.5h | 1.2h | ✓ done |
| T3: Add metrics counter | 22m | — | 0.4h | ✓ done |

**Total elapsed: 2h 12m · Estimated: 1.5h · Actual: 2.2h (+47%)**
```

Rules:
- One row per task. Don't break out per-phase (impl vs review) — the user explicitly asked for task-level only.
- Show the totals line only if at least one task has an estimate. Otherwise omit it.
- Use `✓ done`, `✗ abandoned`, `⚠ escalated` for status. The `✓ ✗ ⚠` characters are fine here — this is a report, not user-facing copy.
- Right after the table, that's the end. Do not add commentary like "as you can see…".

## What you must NOT do

- Do not modify the role prompts at `~/sourceControl/claude-development-eco-system/teams/agent-team/prompts/` — they are the binding contract.
- Do not change gate decisions based on timing. A task that ran 5x its estimate still ships if the gates approved.
- Do not write timing data to a file unless the user asks. Keep it in conversation context.
- Do not emit the report mid-workflow. One report, at the end.
- Do not add per-role breakdowns (Implementor time vs Reviewer time). The user asked for task name + total elapsed + estimate vs actual — nothing else.
- Do not delay tool calls to "round" timestamps. Capture `now()` at the moment of the call, raw.

## Edge cases

- **Single-task workflow** (most `/quick-fix` runs): still emit the table — one row is fine.
- **Workflow aborted by user** mid-flight: emit the report for whatever tasks closed, mark the in-flight one as `abandoned` with elapsed-so-far.
- **No plan / no estimate** (e.g. `/dev-roles architect-consult`): skip the report entirely. Architect-consult mode has no task lifecycle.
- **Multiple TaskUpdate calls** between create and done (status moves through PLAN_IN_PROGRESS → PLAN_UNDER_REVIEW → IMPLEMENTATION_IN_PROGRESS → ...): only the first (`TaskCreate`) and the last (terminal `TaskUpdate`) matter for timing. Ignore the intermediate ones for the report.

## Composition with other skills

- Composes with `/feature` — the Phase G handoff already prints a summary; append the timing table just before it.
- Composes with `/done` — `/done` records actual hours into the plan frontmatter and the calibration log. This skill's report is the in-conversation version; `/done` is the durable version. They are not redundant — the report is what the user reads now, `/done` is what trains the team's velocity over time.
- Does NOT compose with `/code-review` or `/learn` — those don't drive a task lifecycle.

## Examples

**`/dev-roles full Add rate limiter to /api/upload`** — one task. After both gates approve and you switch back to CTO to close, capture `ended_at`, then before your Step 3 summary print:

```
### Task timing

| Task | Elapsed | Estimate | Actual | Status |
|---|---|---|---|---|
| T1: Add rate limiter to /api/upload | 41m | 0.5h | 0.7h | ✓ done |
```

**`/feature add saved-search feature`** — three CTO-decomposed tasks. After Phase E closes the last one, before Phase G:

```
### Task timing

| Task | Elapsed | Estimate | Actual | Status |
|---|---|---|---|---|
| T1: Saved-search schema + migration | 28m | 0.5h | 0.5h | ✓ done |
| T2: Saved-search API routes | 1h 5m | 1.0h | 1.1h | ✓ done |
| T3: Saved-search UI panel | 2h 18m | 1.5h | 2.3h | ✓ done |

**Total elapsed: 3h 51m · Estimated: 3.0h · Actual: 3.9h (+30%)**
```
