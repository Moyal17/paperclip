import { z } from "zod";
import { multilineTextSchema } from "./text.js";

// Agent-facing git-ops payloads.
//
// SECURITY BOUNDARY: agents NEVER supply repository, remote, branch, or base
// fields. The push target (fork remote + branch) and the PR base branch are
// derived server-side from the project's git-ops policy and the issue's
// execution workspace. Accepting any target-shaped field here would let a
// prompt-injected agent redirect a credentialed push or open a PR against an
// arbitrary repo. Keep both schemas `.strict()` and free of such fields.

export const gitPushRequestSchema = z.object({}).strict();

export const openPullRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(256),
    body: multilineTextSchema.pipe(z.string().max(65536)).optional().nullable(),
    draft: z.boolean().optional(),
  })
  .strict();

// Validates `projects.execution_workspace_policy.gitOps`. Operator-set config;
// the only place push/PR targets come from. `tokenSecretName` references a
// company secret resolved server-side — never an env binding.
export const gitOpsProjectPolicySchema = z
  .object({
    remoteUrl: z.string().url().max(2048),
    baseBranch: z.string().trim().min(1).max(255).default("master"),
    tokenSecretName: z.string().trim().min(1).max(255),
  })
  .strip();

export type GitPushRequest = z.infer<typeof gitPushRequestSchema>;
export type OpenPullRequest = z.infer<typeof openPullRequestSchema>;
export type GitOpsProjectPolicy = z.infer<typeof gitOpsProjectPolicySchema>;
