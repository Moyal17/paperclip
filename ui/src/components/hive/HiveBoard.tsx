import { useMemo, useState } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Issue } from "@paperclipai/shared";
import {
  HIVE_COLUMNS,
  type HiveColumnId,
  canDropOnColumn,
  columnForIssue,
  projectIssuesToHiveColumns,
  targetStatusForColumn,
} from "../../lib/hive-board";
import { useStageTransition } from "../../hooks/useStageTransition";
import { useToastActions } from "../../context/ToastContext";
import { HiveCard } from "./HiveCard";
import { HivePlanCard } from "./HivePlanCard";

interface Agent {
  id: string;
  name: string;
}

interface HiveBoardProps {
  issues: Issue[];
  agents?: Agent[];
  companyId: string | null;
  // issueId -> live runId, for the Stop control + live indicator.
  liveRunByIssue?: Map<string, string>;
}

export function HiveBoard({ issues, agents, companyId, liveRunByIssue }: HiveBoardProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const stageTransition = useStageTransition(companyId);
  const { pushToast } = useToastActions();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columns = useMemo(() => projectIssuesToHiveColumns(issues), [issues]);
  const agentName = useMemo(() => {
    const map = new Map((agents ?? []).map((a) => [a.id, a.name]));
    return (id: string | null) => (id ? map.get(id) ?? null : null);
  }, [agents]);

  const activeIssue = activeId ? issues.find((i) => i.id === activeId) ?? null : null;

  function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const { active, over } = event;
    if (!over) return;
    const issue = issues.find((i) => i.id === active.id);
    if (!issue) return;

    const from = columnForIssue(issue);
    const overId = over.id as string;
    const to: HiveColumnId = HIVE_COLUMNS.some((c) => c.id === overId)
      ? (overId as HiveColumnId)
      : columnForIssue(issues.find((i) => i.id === overId) ?? issue);

    if (to === from) return;
    if (!canDropOnColumn(from, to)) {
      pushToast({
        title: "Move not allowed",
        body: from === "plans" || to === "plans"
          ? "Plans can't be dragged between columns. Use Activate."
          : "Tasks only move forward. Use the Cancel action to back out.",
        tone: "info",
      });
      return;
    }
    const status = targetStatusForColumn(to);
    if (status) stageTransition.mutate({ id: issue.id, status });
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={(e: DragStartEvent) => setActiveId(e.active.id as string)}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
      <div className="flex gap-3 overflow-x-auto pb-4">
        {HIVE_COLUMNS.map((col) => (
          <HiveColumnView
            key={col.id}
            id={col.id}
            label={col.label}
            issues={columns[col.id]}
            companyId={companyId}
            agentName={agentName}
            liveRunByIssue={liveRunByIssue}
          />
        ))}
      </div>
      <DragOverlay>
        {activeIssue ? (
          <HiveCard issue={activeIssue} companyId={companyId} agentName={agentName} isOverlay />
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function HiveColumnView({
  id,
  label,
  issues,
  companyId,
  agentName,
  liveRunByIssue,
}: {
  id: HiveColumnId;
  label: string;
  issues: Issue[];
  companyId: string | null;
  agentName: (id: string | null) => string | null;
  liveRunByIssue?: Map<string, string>;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const isPlans = id === "plans";

  return (
    <section
      aria-label={`${label} column`}
      className="flex w-[280px] shrink-0 flex-col"
    >
      <div className="mb-1 flex items-center gap-2 px-2 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground/60">{issues.length}</span>
      </div>
      <div
        ref={setNodeRef}
        className={`min-h-[140px] flex-1 space-y-1.5 rounded-md p-1.5 transition-colors ${
          isOver && !isPlans ? "bg-accent/40" : "bg-muted/20"
        }`}
      >
        {isPlans ? (
          issues.map((issue) => (
            <HivePlanCard key={issue.id} issue={issue} companyId={companyId} />
          ))
        ) : (
          <SortableContext items={issues.map((i) => i.id)} strategy={verticalListSortingStrategy}>
            {issues.map((issue) => (
              <HiveCard
                key={issue.id}
                issue={issue}
                companyId={companyId}
                agentName={agentName}
                isLive={liveRunByIssue?.has(issue.id)}
                liveRunId={liveRunByIssue?.get(issue.id) ?? null}
              />
            ))}
          </SortableContext>
        )}
        {issues.length === 0 && (
          <p className="px-1 pt-1 text-[11px] text-muted-foreground/70">
            {isPlans ? "No plans yet." : "Empty."}
          </p>
        )}
      </div>
    </section>
  );
}
