# BUG-005 — Cold-rotation comment contradicts outer guard; missing rotation test coverage

| | |
|---|---|
| **Severity** | LOW |
| **Backlog item** | A1b (universal cold-session rotation) / A1a (proactive rotation) |
| **Origin commits** | `a1234a82` (A1b), `f6974dff` (A1a) |
| **Files** | `server/src/services/heartbeat.ts`, `server/src/__tests__/session-rotation-decision.test.ts` |
| **Category** | Type Safety & Code Quality (doc accuracy) / Testing |
| **Status** | Fixed |

## Summary

Two genuine defects, both low-severity. The cold-rotation *behavior* itself is correct and **was not
changed** (see "Not a bug" below).

### 1. Misleading comment (doc accuracy)

The A1b block in `decideSessionRotation` claimed it "fires regardless of token threshold because the
replay cost is real whether or not a maxRawInputTokens cap is configured." Taken at face value this is
wrong for the full call chain: the caller `evaluateSessionCompaction` returns early when
`hasSessionCompactionThresholds(policy)` is false. Adapter-managed policies
(`ADAPTER_MANAGED_SESSION_POLICY`: runs/tokens/age all `0`, used by adapters with native context
management such as `acpx_local`, `codex_local`) therefore never reach A1b — the opposite of what the
comment implied. A future maintainer reading only the inner comment would expect those adapters to
cold-rotate. `claude_local` uses `CLAUDE_NATIVE_COST_ROTATION_POLICY` (`maxRawInputTokens` 400k > 0),
so it does pass the guard and A1b is active there — which is the path that matters for pilots.

### 2. Untested rotation branches

The pure `decideSessionRotation` suite never exercised:
- the **age** branch (`maxSessionAgeHours` was `0` in every case) — zero coverage;
- the **runCount == maxSessionRuns** boundary (condition is `>`, so equality must *not* rotate) — an
  off-by-one regression from `>` to `>=` would have gone undetected.

## Fix

- Rewrote the A1b comment to state that it fires independent of the token *value* but is only reached
  for policies with at least one non-zero threshold, so adapter-managed (native-context) policies are
  intentionally exempt.
- Added three tests: age rotates at `>=` limit, age does not rotate just below it, and
  `runCount == maxSessionRuns` does not rotate. Each isolates its branch with a hot cache
  (suppresses A1b) and `maxRawInputTokens: 0` (suppresses A4/A1a).

## Verification

- `npx vitest run src/__tests__/session-rotation-decision.test.ts` → **18 passed** (3 new).

## Not a bug (working as intended)

The reviewers also flagged that A1b cold-rotates age- or token-capped sessions on any >5-min gap,
calling it an unexpected behavior change. This is the **designed** behavior of A1b: a cold `--resume`
re-bills the entire transcript at full price once the wake outlives the Anthropic prompt-cache TTL,
so the run starts fresh carrying a handoff/continuation summary instead. Continuity is preserved by
the handoff, and the cost curve is flattened — the whole point of A1a/A1b. No behavior change was
made.
