# Dev-Team Project Setup — isolated worktrees + branch convention

For a Hive project whose issues are built by the Development Team, configure the
project's **execution workspace policy** so every issue run lands in its own git
worktree on a predictably named branch. This is pure configuration — Paperclip
already realizes the worktree at run time (`heartbeat` →
`realizeExecutionWorkspace`); the policy just sets the strategy and branch name.

## What to set on the project

`projects.executionWorkspacePolicy` (JSONB):

```json
{
  "enabled": true,
  "defaultMode": "isolated_workspace",
  "workspaceStrategy": {
    "type": "git_worktree",
    "branchTemplate": "issue/{{issue.identifier}}-{{slug}}",
    "baseRef": "master",
    "worktreeParentDir": ".paperclip/worktrees"
  }
}
```

- **`defaultMode: "isolated_workspace"`** — each issue gets its own workspace
  instead of sharing the project primary, so parallel dev-team agents never
  collide on one checkout.
- **`workspaceStrategy.type: "git_worktree"`** — realize an isolated branch via
  `git worktree add` rather than reusing the primary clone.
- **`branchTemplate: "issue/{{issue.identifier}}-{{slug}}"`** — the branch
  convention. Without the `issue/` prefix the default template
  (`{{issue.identifier}}-{{slug}}`) yields e.g. `PAP-123-add-foo`; with it you
  get `issue/PAP-123-add-foo`, grouping all dev-team branches under one prefix
  for easy filtering and PR hygiene.
- **`baseRef`** — branch the worktree forks from (the fork's default branch).
- **`worktreeParentDir`** — where worktrees live under the repo root
  (default `.paperclip/worktrees`).

The project's **primary project workspace** (`project_workspaces`, `isPrimary`)
must have its `cwd` pointing at the local clone of the target repo — that clone
is the source of truth `realizeExecutionWorkspace` runs `git worktree add`
against.

## Lifecycle

1. Activate a `gateProfile: "dev_team"` plan → child issues materialized.
2. A child is assigned and runs → heartbeat realizes
   `issue/<identifier>-<slug>` as an isolated worktree, persisted as an
   `execution_workspaces` row with `sourceIssueId = <child>` and
   `providerType = "git_worktree"`.
3. Plan / code / wiring gates review that one branch's diff.
4. The child reaches a terminal status (`done` / `cancelled`) → Paperclip flags
   the owned worktree's `cleanupEligibleAt` + `cleanupReason = issue_<status>`
   (A2 cleanup hook). **Branches are never auto-deleted** — the existing
   close-readiness machinery decides teardown; the operator keeps the branch
   until the PR merges.

## Notes

- The cleanup flag only fires for a worktree the issue **owns**
  (`sourceIssueId` matches) and only for `git_worktree` providers — a shared
  project workspace referenced by many issues is never flagged.
- No schema change backs the branch convention; it is entirely the project
  policy above. Changing the template only affects worktrees realized after the
  change.
