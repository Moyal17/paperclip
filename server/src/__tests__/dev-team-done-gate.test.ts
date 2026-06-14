import { describe, expect, it } from "vitest";
import { evaluateDevTeamDoneReadiness } from "../services/plan-gates.js";

// Fix 3 (B1 gap-fix): the pure decision behind the hard `done` guard. An agent
// may not close a dev_team-gated issue until its PR is open and both review
// gates are approved; non-dev_team / non-done transitions are never gated.

const base = {
  gateProfile: "dev_team" as string | null,
  targetStatus: "done",
  currentStatus: "in_review",
  prUrl: "https://github.com/Moyal17/paperclip/pull/1",
  reviewGateStatuses: ["approved", "approved"],
};

describe("evaluateDevTeamDoneReadiness", () => {
  it("is ready when PR is open and both review gates are approved", () => {
    expect(evaluateDevTeamDoneReadiness(base).reasons).toEqual([]);
  });

  it("flags missing_pr when there is no PR", () => {
    expect(evaluateDevTeamDoneReadiness({ ...base, prUrl: null }).reasons).toEqual(["missing_pr"]);
  });

  it("flags gates_pending when a review gate is still pending", () => {
    expect(
      evaluateDevTeamDoneReadiness({ ...base, reviewGateStatuses: ["approved", "pending"] }).reasons,
    ).toEqual(["gates_pending"]);
  });

  it("flags gates_pending when a review gate is rejected", () => {
    expect(
      evaluateDevTeamDoneReadiness({ ...base, reviewGateStatuses: ["rejected", "approved"] }).reasons,
    ).toEqual(["gates_pending"]);
  });

  it("flags both reasons when PR missing and gates pending", () => {
    expect(
      evaluateDevTeamDoneReadiness({ ...base, prUrl: null, reviewGateStatuses: ["pending", "pending"] }).reasons,
    ).toEqual(["missing_pr", "gates_pending"]);
  });

  it("treats no review gates as no gates_pending (PR still required)", () => {
    expect(evaluateDevTeamDoneReadiness({ ...base, reviewGateStatuses: [] }).reasons).toEqual([]);
    expect(
      evaluateDevTeamDoneReadiness({ ...base, prUrl: null, reviewGateStatuses: [] }).reasons,
    ).toEqual(["missing_pr"]);
  });

  it("never gates a none or solo plan", () => {
    expect(
      evaluateDevTeamDoneReadiness({ ...base, gateProfile: "none", prUrl: null, reviewGateStatuses: ["pending"] }).reasons,
    ).toEqual([]);
    expect(
      evaluateDevTeamDoneReadiness({ ...base, gateProfile: null, prUrl: null, reviewGateStatuses: ["pending"] }).reasons,
    ).toEqual([]);
    // solo is the HIV-13 fix: a shared-branch task with no PR must still close.
    expect(
      evaluateDevTeamDoneReadiness({ ...base, gateProfile: "solo", prUrl: null, reviewGateStatuses: [] }).reasons,
    ).toEqual([]);
  });

  it("gates a light plan on its review gate but never requires a PR", () => {
    // No PR + approved gate → ready (light skips missing_pr).
    expect(
      evaluateDevTeamDoneReadiness({ ...base, gateProfile: "light", prUrl: null, reviewGateStatuses: ["approved"] }).reasons,
    ).toEqual([]);
    // Pending gate → blocked on gates only (not missing_pr).
    expect(
      evaluateDevTeamDoneReadiness({ ...base, gateProfile: "light", prUrl: null, reviewGateStatuses: ["pending"] }).reasons,
    ).toEqual(["gates_pending"]);
  });

  it("never gates a transition that is not to done", () => {
    expect(
      evaluateDevTeamDoneReadiness({ ...base, targetStatus: "in_review", prUrl: null, reviewGateStatuses: ["pending"] }).reasons,
    ).toEqual([]);
  });

  it("is a no-op when the issue is already done", () => {
    expect(
      evaluateDevTeamDoneReadiness({ ...base, currentStatus: "done", prUrl: null, reviewGateStatuses: ["pending"] }).reasons,
    ).toEqual([]);
  });
});
