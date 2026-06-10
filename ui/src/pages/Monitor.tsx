import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import { heartbeatsApi } from "../api/heartbeats";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { Identity } from "../components/Identity";
import { EmptyState } from "../components/EmptyState";

// Live monitor: which agents are running right now, and a tail of the selected
// run's output. Log is polled by byte offset every 2s and appended.
export function Monitor() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Monitor" }]);
  }, [setBreadcrumbs]);

  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId,
    refetchInterval: 2000,
  });

  const runs = liveRuns ?? [];

  // Auto-select the first run when nothing is selected (or the selection died).
  useEffect(() => {
    if (runs.length === 0) {
      if (selectedRunId) setSelectedRunId(null);
      return;
    }
    if (!selectedRunId || !runs.some((r) => r.id === selectedRunId)) {
      setSelectedRunId(runs[0].id);
    }
  }, [runs, selectedRunId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="px-4 py-3">
        <h1 className="text-lg font-semibold">Monitor</h1>
        <p className="text-xs text-muted-foreground">
          {runs.length} active run{runs.length === 1 ? "" : "s"}
        </p>
      </header>

      <div className="flex min-h-0 flex-1 gap-3 px-4 pb-4">
        <aside className="w-64 shrink-0 space-y-1 overflow-y-auto">
          {runs.length === 0 ? (
            <p className="px-2 py-4 text-sm text-muted-foreground">No agents running.</p>
          ) : (
            runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => setSelectedRunId(run.id)}
                className={`flex w-full flex-col gap-1 rounded-md border px-2.5 py-2 text-left text-sm transition-colors ${
                  selectedRunId === run.id ? "border-primary bg-primary/5" : "border-border hover:bg-accent/50"
                }`}
              >
                <Identity name={run.agentName} size="xs" />
                <span className="truncate text-[11px] text-muted-foreground">
                  {run.invocationSource}
                  {run.issueId ? ` · ${run.issueId.slice(0, 8)}` : ""}
                </span>
              </button>
            ))
          )}
        </aside>

        <div className="min-w-0 flex-1">
          {selectedRunId ? (
            <RunLogTail runId={selectedRunId} />
          ) : (
            <EmptyState icon={Radio} message="Nothing running — agent output will stream here when work starts." />
          )}
        </div>
      </div>
    </div>
  );
}

function RunLogTail({ runId }: { runId: string }) {
  const [content, setContent] = useState("");
  const offsetRef = useRef(0);
  const scrollRef = useRef<HTMLPreElement>(null);

  // Reset when the run changes.
  useEffect(() => {
    setContent("");
    offsetRef.current = 0;
  }, [runId]);

  const { data } = useQuery({
    queryKey: [...queryKeys.runDetail(runId), "log-tail", runId],
    queryFn: () => heartbeatsApi.log(runId, offsetRef.current),
    refetchInterval: 2000,
  });

  useEffect(() => {
    if (!data) return;
    if (data.content) {
      setContent((prev) => prev + data.content);
    }
    if (typeof data.nextOffset === "number") {
      offsetRef.current = data.nextOffset;
    }
  }, [data]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [content]);

  return (
    <pre
      ref={scrollRef}
      className="h-full overflow-auto rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed"
    >
      {content || <span className="text-muted-foreground">No output captured yet.</span>}
    </pre>
  );
}
