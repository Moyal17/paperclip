import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { OctagonX } from "lucide-react";
import { plansApi } from "../../api/plans";
import { useCompany } from "../../context/CompanyContext";
import { useToastActions } from "../../context/ToastContext";
import { queryKeys } from "../../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "./ConfirmActionDialog";

// Company-wide hard stop. Engaging cancels every running agent and pauses the
// company so nothing new can start; releasing re-activates it. The state mirrors
// the company's manual pause so a reload reflects reality.
export function GlobalKillSwitch() {
  const queryClient = useQueryClient();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const { pushToast } = useToastActions();
  const [confirm, setConfirm] = useState(false);

  const engaged =
    selectedCompany?.status === "paused" && selectedCompany?.pauseReason === "manual";

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.companies.all });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.companies.detail(selectedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.liveMeter(selectedCompanyId) });
    }
  };

  const engage = useMutation({
    mutationFn: () => plansApi.engageKillSwitch(selectedCompanyId!),
    onSuccess: () => {
      pushToast({ title: "Kill switch engaged", body: "All agent work cancelled.", tone: "warn" });
      setConfirm(false);
      refresh();
    },
    onError: (e) =>
      pushToast({ title: "Kill switch failed", body: errMsg(e), tone: "error" }),
  });

  const release = useMutation({
    mutationFn: () => plansApi.releaseKillSwitch(selectedCompanyId!),
    onSuccess: () => {
      pushToast({ title: "Kill switch released", body: "Company re-activated.", tone: "success" });
      refresh();
    },
    onError: (e) => pushToast({ title: "Release failed", body: errMsg(e), tone: "error" }),
  });

  if (!selectedCompanyId) return null;

  if (engaged) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 border-red-400/60 text-red-700 dark:text-red-300"
        onClick={() => release.mutate()}
        disabled={release.isPending}
      >
        <OctagonX className="h-4 w-4" />
        Release kill switch
      </Button>
    );
  }

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        className="gap-1.5"
        onClick={() => setConfirm(true)}
        aria-label="Engage global kill switch"
      >
        <OctagonX className="h-4 w-4" />
        Kill switch
      </Button>
      <ConfirmActionDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Engage the kill switch?"
        description="This immediately cancels every running agent in this company and pauses it so no new work can start. You can release it again at any time."
        confirmLabel="Engage kill switch"
        destructive
        pending={engage.isPending}
        onConfirm={() => engage.mutate()}
      />
    </>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
