# BUG-001 — Silent project-create failure ships pilots without worktree isolation

| | |
|---|---|
| **Severity** | HIGH |
| **Backlog item** | A4/G — worktree isolation for agent execution |
| **Origin commit** | `8a6e9ed3` fix(scripts): wire pilot plans to a git_worktree project (A4/G) |
| **Files** | `scripts/create-pilot-company.sh`, `scripts/create-pilot-plan.sh` |
| **Category** | Error Handling |
| **Status** | Fixed |

## Summary

The whole point of A4/G is to create each pilot inside a `git_worktree`-isolated project so
implementor runs do not edit the watched tree (which hot-reloads the dev server and detaches the
run — `process_detached`). The provisioning scripts swallowed the failure path: when the project
POST failed, the script printed a soft warning and **kept going**, creating a plan with no
`projectId` — i.e. no isolation — while still reporting "Pilot is live." The exact failure mode the
feature exists to prevent shipped silently.

## Reproduction

1. Run `create-pilot-company.sh "Hive Pilot" --with-pilot "..." "..."` against a server whose
   `POST /companies/:id/projects` returns a 4xx/5xx (e.g. schema validation error on
   `executionWorkspacePolicy`, or a transient 500).
2. `curl` fails; the old code (`... 2>/dev/null || echo '{}'`) substituted `{}`.
3. `PROJECT_ID` resolves empty → branch prints `warning: could not create pilot project
   (agents will use scratch dir)` to stderr and continues.
4. The pilot plan is created with `${PROJECT_ID:-}` (empty) → no project → no worktree policy.
5. Script prints "Pilot is live." Operator believes isolation is active. It is not.

## Root cause

- `create-pilot-company.sh:115-144` — `2>/dev/null || echo '{}'` on the project POST masked the HTTP
  error, and the empty-`PROJECT_ID` branch was a non-fatal `>&2` warning.
- `create-pilot-plan.sh:88-103` — the project lookup used `... 2>/dev/null || echo '[]'`, so a server
  outage or auth failure was indistinguishable from "company legitimately has no project," and the
  script proceeded to create an unisolated plan.

## Fix

- **create-pilot-company.sh** — drop `2>/dev/null || echo '{}'`. On a failed POST, print why
  isolation matters and `exit 1`. If the POST succeeds but returns no id, dump the response body and
  `exit 1`. Project creation is a step the script performs deliberately, so its failure is fatal.
- **create-pilot-plan.sh** — make the `GET /projects` *request failure* fatal (`exit 1`) instead of
  falling back to `[]`. A genuinely empty project list (company has no project yet) stays a warning
  and now tells the operator to run `create-pilot-company.sh` first.

This converts silent degradation-to-unisolated into a loud, early failure. No behavior change on the
happy path.

## Verification

- `bash -n` clean on both scripts.
- Manual trace: a non-2xx project POST now exits 1 before any plan is created; an empty list still
  warns but no longer hides a server/network error.

## Residual / follow-up

- `cwd: $REPO_ROOT` is resolved on the machine running the script; valid only when the script and the
  server share a filesystem (local pilot). Out of scope here — tracked as a doc note, not a code fix.
