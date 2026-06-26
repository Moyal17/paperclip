import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { plansApi, type AgentHealthEntry, type SupervisionNote } from "../../api/plans";
import { agentsApi } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";
import { timeAgo } from "../../lib/timeAgo";
import { useToastActions } from "../../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "../../lib/utils";
import { AgentIcon } from "../AgentIconPicker";

const SEVERITY_BADGE: Record<SupervisionNote["severity"], string> = {
  info: "bg-muted text-muted-foreground",
  warning: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  critical: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
};

const KIND_LABEL: Record<SupervisionNote["kind"], string> = {
  observation: "Observation",
  overrun: "ETA Overrun",
  action: "Action",
};

const HEALTH_LABEL: Record<AgentHealthEntry["health"], string> = {
  working: "Working",
  stuck: "Stuck",
  stuck_critical: "Stuck (critical)",
  looping: "Looping",
  needs_rewake: "Needs re-wake",
  paused: "Paused",
};

interface PlanSupervisionTimelineProps {
  planIssueId: string;
  planState: string;
  companyId: string | null;
}

export function PlanSupervisionTimeline({ planIssueId, planState, companyId }: PlanSupervisionTimelineProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const isActive = planState === "active";
  const [reassignDialog, setReassignDialog] = useState<AgentHealthEntry | null>(null);
  const [reassignToAgentId, setReassignToAgentId] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: queryKeys.hive.planSupervision(planIssueId),
    queryFn: () => plansApi.supervisionNotes(planIssueId),
  });

  const { data: healthData } = useQuery({
    queryKey: queryKeys.hive.planHealth(planIssueId),
    queryFn: () => plansApi.supervisionHealth(planIssueId),
    enabled: isActive,
  });

  const { data: agentsData } = useQuery({
    queryKey: companyId ? queryKeys.agents.list(companyId) : (["agents", null] as const),
    queryFn: () => agentsApi.list(companyId!),
    enabled: isActive && !!companyId,
  });

  const invalidateSupervision = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.hive.planSupervision(planIssueId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.hive.planHealth(planIssueId) });
  };

  const monitorNow = useMutation({
    mutationFn: () => plansApi.monitorNow(planIssueId),
    onSuccess: (r) => {
      pushToast({
        title: r.woken ? "CTO woken for monitoring" : "No CTO agent found",
        tone: r.woken ? "success" : "error",
      });
      invalidateSupervision();
    },
    onError: (e) => pushToast({ title: "Could not trigger monitoring", body: errMsg(e), tone: "error" }),
  });

  const rewake = useMutation({
    mutationFn: (targetAgentId: string) =>
      plansApi.takeAction(planIssueId, { action: "rewake", targetAgentId }),
    onSuccess: () => {
      pushToast({ title: "Agent re-woken", tone: "success" });
      invalidateSupervision();
    },
    onError: (e) => pushToast({ title: "Re-wake failed", body: errMsg(e), tone: "error" }),
  });

  const cancelRun = useMutation({
    mutationFn: ({ runId, targetAgentId }: { runId: string; targetAgentId: string }) =>
      plansApi.takeAction(planIssueId, { action: "cancel", runId, targetAgentId }),
    onSuccess: () => {
      pushToast({ title: "Run cancelled", tone: "success" });
      invalidateSupervision();
    },
    onError: (e) => pushToast({ title: "Cancel failed", body: errMsg(e), tone: "error" }),
  });

  const stopEscalate = useMutation({
    mutationFn: (reason: string) =>
      plansApi.takeAction(planIssueId, { action: "stop_escalate", reason }),
    onSuccess: () => {
      pushToast({ title: "Plan stopped & escalated", tone: "success" });
      invalidateSupervision();
      queryClient.invalidateQueries({ queryKey: queryKeys.hive.plan(planIssueId) });
    },
    onError: (e) => pushToast({ title: "Stop & escalate failed", body: errMsg(e), tone: "error" }),
  });

  const reassign = useMutation({
    mutationFn: ({ targetIssueId, newAssigneeAgentId }: { targetIssueId: string; newAssigneeAgentId: string }) =>
      plansApi.takeAction(planIssueId, { action: "reassign", targetIssueId, newAssigneeAgentId }),
    onSuccess: (_, { targetIssueId }) => {
      pushToast({ title: "Issue reassigned", tone: "success" });
      invalidateSupervision();
      if (companyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(targetIssueId) });
      }
      setReassignDialog(null);
      setReassignToAgentId(null);
    },
    onError: (e) => pushToast({ title: "Reassign failed", body: errMsg(e), tone: "error" }),
  });

  const onStopEscalate = () => {
    const reason = window.prompt(
      "Stop this plan and escalate to the board? This cancels all active work.\n\nReason:",
      "Escalating to board — needs human decision",
    );
    if (reason === null) return;
    stopEscalate.mutate(reason.trim() || "Stopped and escalated to board");
  };

  const notes = data?.notes ?? [];
  const agents = healthData?.health.agents ?? [];
  const overdue = healthData?.health.overdue ?? false;
  const actionPending = rewake.isPending || stopEscalate.isPending || cancelRun.isPending || reassign.isPending;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          CTO Supervision
        </h3>
        {isActive && (
          <Button
            variant="outline"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => monitorNow.mutate()}
            disabled={monitorNow.isPending}
          >
            {monitorNow.isPending ? "Waking…" : "Monitor now"}
          </Button>
        )}
      </div>

      {/* Agent health + remediation actions (active plans only) */}
      {isActive && (
        <div className="space-y-2 rounded-md border border-border p-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-muted-foreground">Agent health</span>
            {overdue && (
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-red-700 dark:text-red-300">
                Overdue
              </Badge>
            )}
          </div>

          {agents.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">No active agents on this plan.</p>
          ) : (
            <ul className="space-y-1.5">
              {agents.map((agent) => (
                <li key={`${agent.agentId}:${agent.issueId}`} className="flex items-center gap-2 text-xs">
                  <span
                    className={`inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_BADGE[agent.severity]}`}
                  >
                    {HEALTH_LABEL[agent.health]}
                  </span>
                  <span className="min-w-0 flex-1 truncate" title={agent.detail}>
                    {agent.agentName ?? agent.agentId.slice(0, 8)}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => rewake.mutate(agent.agentId)}
                    disabled={actionPending}
                  >
                    Re-wake
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 shrink-0 px-2 text-[11px]"
                    onClick={() => { setReassignDialog(agent); setReassignToAgentId(null); }}
                    disabled={actionPending}
                  >
                    Reassign
                  </Button>
                  {agent.runId && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 shrink-0 px-2 text-[11px] text-red-700 hover:text-red-800 dark:text-red-300"
                      onClick={() => cancelRun.mutate({ runId: agent.runId!, targetAgentId: agent.agentId })}
                      disabled={actionPending}
                    >
                      {cancelRun.isPending ? "Cancelling…" : "Cancel run"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <Button
            variant="outline"
            size="sm"
            className="h-7 w-full text-xs text-red-700 hover:text-red-800 dark:text-red-300"
            onClick={onStopEscalate}
            disabled={actionPending}
          >
            {stopEscalate.isPending ? "Stopping…" : "Stop & escalate to board"}
          </Button>
        </div>
      )}

      <ReassignDialog
        open={!!reassignDialog}
        agent={reassignDialog}
        agents={agentsData ?? []}
        selectedAgentId={reassignToAgentId}
        onSelectAgent={setReassignToAgentId}
        pending={reassign.isPending}
        onConfirm={() => {
          if (!reassignDialog || !reassignToAgentId) return;
          reassign.mutate({ targetIssueId: reassignDialog.issueId, newAssigneeAgentId: reassignToAgentId });
        }}
        onClose={() => { setReassignDialog(null); setReassignToAgentId(null); }}
      />

      {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}

      {!isLoading && notes.length === 0 && (
        <p className="text-xs text-muted-foreground">No supervision notes yet.</p>
      )}

      <div className="space-y-2">
        {notes.map((note) => (
          <SupervisionNoteCard key={note.id} note={note} />
        ))}
      </div>
    </div>
  );
}

interface ReassignDialogProps {
  open: boolean;
  agent: AgentHealthEntry | null;
  agents: Agent[];
  selectedAgentId: string | null;
  onSelectAgent: (id: string | null) => void;
  pending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

function ReassignDialog({
  open,
  agent,
  agents,
  selectedAgentId,
  onSelectAgent,
  pending,
  onConfirm,
  onClose,
}: ReassignDialogProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  // Filters out inactive agents. orgChainHealth-based pre-filtering (e.g. restricting
  // to agents within the plan's org chain) is not yet surfaced by the agents API;
  // board users see all active agents and must pick a valid one.
  const eligibleAgents = agents.filter(
    (a) => a.status !== "terminated" && a.status !== "pending_approval",
  );
  const selectedAgent = selectedAgentId ? agents.find((a) => a.id === selectedAgentId) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reassign issue</DialogTitle>
          <DialogDescription>
            Reassign{" "}
            <span className="font-mono text-xs text-foreground">
              {agent?.issueId.slice(0, 8)}
            </span>{" "}
            (currently assigned to{" "}
            <span className="font-medium">{agent?.agentName ?? agent?.agentId.slice(0, 8)}</span>
            ) to a new agent.
          </DialogDescription>
        </DialogHeader>

        <div className="py-2">
          <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className={cn(
                  "inline-flex w-full items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-accent/50 transition-colors",
                  !selectedAgent && "text-muted-foreground",
                )}
              >
                {selectedAgent ? (
                  <>
                    <AgentIcon icon={selectedAgent.icon} className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{selectedAgent.name}</span>
                  </>
                ) : (
                  "Select new assignee…"
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-56 p-1" align="start">
              {eligibleAgents.length === 0 ? (
                <p className="px-2 py-1.5 text-xs text-muted-foreground">No eligible agents.</p>
              ) : (
                eligibleAgents.map((a) => (
                  <button
                    key={a.id}
                    type="button"
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-accent/50 overflow-hidden",
                      a.id === selectedAgentId && "bg-accent",
                    )}
                    onClick={() => { onSelectAgent(a.id); setPickerOpen(false); }}
                  >
                    <AgentIcon icon={a.icon} className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{a.name}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">{a.role}</span>
                  </button>
                ))
              )}
            </PopoverContent>
          </Popover>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending || !selectedAgentId}>
            {pending ? "Reassigning…" : "Reassign"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SupervisionNoteCard({ note }: { note: SupervisionNote }) {
  return (
    <div className="rounded-md border border-border p-2.5 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${SEVERITY_BADGE[note.severity]}`}
        >
          {note.severity}
        </span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
          {KIND_LABEL[note.kind]}
        </span>
        {note.actionTaken && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {note.actionTaken}
          </Badge>
        )}
        <span className="ml-auto text-[10px] text-muted-foreground">
          {timeAgo(note.createdAt)}
        </span>
      </div>
      <p className="text-xs text-foreground whitespace-pre-wrap">{note.body}</p>
    </div>
  );
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong.";
}
