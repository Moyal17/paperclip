import { describe, expect, it } from "vitest";
import {
  resolveSessionCompactionPolicy,
  hasSessionCompactionThresholds,
} from "./session-compaction.js";

describe("session compaction — claude_local cost rotation (W3)", () => {
  it("gives claude_local a non-zero raw-input-token rotation threshold by default", () => {
    const { policy, source } = resolveSessionCompactionPolicy("claude_local", {});
    expect(policy.enabled).toBe(true);
    expect(policy.maxRawInputTokens).toBeGreaterThan(0);
    expect(hasSessionCompactionThresholds(policy)).toBe(true);
    expect(source).toBe("adapter_default");
  });

  it("rotates claude_local on tokens only — not run count or age", () => {
    const { policy } = resolveSessionCompactionPolicy("claude_local", {});
    expect(policy.maxSessionRuns).toBe(0);
    expect(policy.maxSessionAgeHours).toBe(0);
  });

  it("does not start rotating the other native-managed adapters", () => {
    for (const adapterType of ["acpx_local", "codex_local"]) {
      const { policy } = resolveSessionCompactionPolicy(adapterType, {});
      expect(hasSessionCompactionThresholds(policy)).toBe(false);
      expect(policy.maxRawInputTokens).toBe(0);
    }
  });

  it("lets a per-agent override win over the claude_local default", () => {
    const runtimeConfig = {
      heartbeat: { sessionCompaction: { maxRawInputTokens: 250_000 } },
    };
    const { policy, source } = resolveSessionCompactionPolicy("claude_local", runtimeConfig);
    expect(policy.maxRawInputTokens).toBe(250_000);
    expect(source).toBe("agent_override");
  });

  it("lets a per-agent override disable rotation entirely", () => {
    const runtimeConfig = {
      heartbeat: { sessionCompaction: { maxRawInputTokens: 0 } },
    };
    const { policy } = resolveSessionCompactionPolicy("claude_local", runtimeConfig);
    expect(policy.maxRawInputTokens).toBe(0);
    expect(hasSessionCompactionThresholds(policy)).toBe(false);
  });
});
