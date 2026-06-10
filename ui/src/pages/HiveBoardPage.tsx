import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { HiveBoard } from "../components/hive/HiveBoard";
import { NewPlanDialog } from "../components/hive/NewPlanDialog";
import { PlanDetailDrawer } from "../components/hive/PlanDetailDrawer";
import { BudgetMeterWidget } from "../components/hive/BudgetMeterWidget";
import { GlobalKillSwitch } from "../components/hive/GlobalKillSwitch";
import { Button } from "@/components/ui/button";
import { PageSkeleton } from "../components/PageSkeleton";

// MyHive board — the single-operator delivery board. Plans | Open | In
// Development | In Review | Done, with per-task and per-plan runaway controls.
export function HiveBoardPage() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [newPlanOpen, setNewPlanOpen] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Board" }]);
  }, [setBreadcrumbs]);

  const { data: issues, isLoading } = useQuery({
    queryKey: queryKeys.hive.board(selectedCompanyId!),
    queryFn: () => issuesApi.list(selectedCompanyId!, { limit: 500 }),
    enabled: !!selectedCompanyId,
  });

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 5000,
  });

  const liveRunByIssue = useMemo(() => {
    const map = new Map<string, string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) map.set(run.issueId, run.id);
    }
    return map;
  }, [liveRuns]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-3 px-4 py-3">
        <h1 className="text-lg font-semibold">Board</h1>
        <div className="ml-auto flex items-center gap-2">
          <GlobalKillSwitch />
          <Button size="sm" className="gap-1.5" onClick={() => setNewPlanOpen(true)}>
            <Plus className="h-4 w-4" />
            New plan
          </Button>
        </div>
      </header>

      <div className="border-b border-border px-4 pb-3">
        <BudgetMeterWidget companyId={selectedCompanyId} />
      </div>

      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {isLoading ? (
          <PageSkeleton />
        ) : (
          <HiveBoard
            issues={issues ?? []}
            agents={agents}
            companyId={selectedCompanyId}
            liveRunByIssue={liveRunByIssue}
          />
        )}
      </div>

      <NewPlanDialog open={newPlanOpen} onOpenChange={setNewPlanOpen} companyId={selectedCompanyId} />
      <PlanDetailDrawer companyId={selectedCompanyId} />
    </div>
  );
}
