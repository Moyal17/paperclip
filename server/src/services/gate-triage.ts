import type { PlanGateProfile } from "@paperclipai/shared";

// Layer 0 — server-side hard-rule floor for gate triage. The CTO requests a
// gate profile (none/solo/light/dev_team); this module computes the *minimum*
// profile the platform will allow for the declared scope and forces the plan up
// to full review when the change touches a high-risk surface. The floor can
// only raise the profile, never lower it — model judgment can ask for less
// review than the floor, but never less than the floor grants. Pure + tested.

// Touching any of these surfaces forces full (dev_team) review regardless of
// the requested profile. Matched case-insensitively against each touched path.
export const GATE_TRIAGE_FORCE_FULL_PATTERNS: readonly RegExp[] = [
  /auth|authz|login|session|token|secret|credential|password/i,
  /migration|\bschema\b|\.sql$/i,
  /payment|billing|invoice|charge|stripe/i,
  // Public API surface — routes and OpenAPI definitions.
  /(^|\/)(routes|openapi)(\/|\.)/i,
];

// Above this many touched files, force full review (blast radius too large for
// a single-reviewer or no-review tier).
export const GATE_TRIAGE_MAX_FILES_BEFORE_FULL = 5;

export interface GateTriageScope {
  touchedPaths?: string[] | null;
  fileCount?: number | null;
}

// True when the declared scope must be reviewed at full (dev_team) strength.
export function forceFullIf(scope: GateTriageScope): boolean {
  const paths = scope.touchedPaths ?? [];
  for (const path of paths) {
    if (GATE_TRIAGE_FORCE_FULL_PATTERNS.some((pattern) => pattern.test(path))) {
      return true;
    }
  }
  const fileCount = scope.fileCount ?? paths.length;
  return fileCount > GATE_TRIAGE_MAX_FILES_BEFORE_FULL;
}

// Final gate profile for a plan: the requested profile, raised to dev_team when
// the Layer 0 floor fires. Never lowers the requested profile.
export function resolveEffectiveGateProfile(
  requested: PlanGateProfile | null | undefined,
  scope: GateTriageScope = {},
): PlanGateProfile {
  if (forceFullIf(scope)) return "dev_team";
  return requested ?? "none";
}
