import { useMutation, useQueryClient } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { ApiError } from "../api/client";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";

// Board status transitions. Unlike the legacy Issues.tsx mutation (which
// swallowed errors silently), this ALWAYS surfaces failures: a rejected
// transition (e.g. 422 from the server stage machine, or a comment-required
// guard) shows an explanatory toast and re-syncs the board so the card snaps
// back to its true column. No optimistic write — we let the refetch be truth.
export function useStageTransition(companyId: string | null) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      issuesApi.update(id, { status }),
    onSuccess: () => {
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      }
    },
    onError: (err) => {
      const message =
        err instanceof ApiError && err.status === 422
          ? bodyMessage(err) ?? "That move isn't allowed from here."
          : err instanceof Error
            ? err.message
            : "Failed to move the task.";
      pushToast({ title: "Move rejected", body: message, tone: "error" });
      // Re-sync so the dragged card returns to its real column.
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      }
    },
  });
}

function bodyMessage(err: ApiError): string | null {
  const body = err.body as { error?: string; message?: string } | undefined;
  return body?.error ?? body?.message ?? null;
}
