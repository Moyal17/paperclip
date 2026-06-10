import { useQuery } from "@tanstack/react-query";
import { plansApi } from "../../api/plans";
import { queryKeys } from "../../lib/queryKeys";
import { formatCents, formatTokens } from "../../lib/utils";
import { QuotaBar } from "../QuotaBar";

interface BudgetMeterWidgetProps {
  companyId: string | null;
}

// Live spend meter: per-active-plan utilization against its cap, plus any
// company-scoped policy bars. Polls every 30s; WS-driven invalidation refreshes
// it sooner when a budget threshold trips.
export function BudgetMeterWidget({ companyId }: BudgetMeterWidgetProps) {
  const { data, isLoading } = useQuery({
    queryKey: queryKeys.budgets.liveMeter(companyId!),
    queryFn: () => plansApi.liveMeter(companyId!),
    enabled: !!companyId,
    refetchInterval: 30_000,
  });

  if (!companyId) return null;
  if (isLoading) {
    return <div className="text-xs text-muted-foreground">Loading budget…</div>;
  }
  if (!data) return null;

  const companyPolicies = data.policies.filter((p) => p.scopeType === "company");
  const activePlans = data.activePlans.filter((p) => p.budgetCapTokens || p.budgetCapCents);

  if (companyPolicies.length === 0 && activePlans.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No budget caps set. Add a per-plan cap to auto-stop runaway spend.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {companyPolicies.map((p) => (
        <QuotaBar
          key={p.policyId}
          label={`Company · ${metricLabel(p.metric)}`}
          percentUsed={p.utilizationPercent}
          leftLabel={`${formatAmount(p.metric, p.observedAmount)} / ${formatAmount(p.metric, p.amount)}`}
          rightLabel={`${Math.round(p.utilizationPercent)}%`}
          showDeficitNotch={p.status === "hard_stop"}
        />
      ))}
      {activePlans.map((plan) => {
        const cap = plan.budgetCapTokens ?? plan.budgetCapCents ?? 0;
        const observed = plan.observedAmount ?? 0;
        const pct = plan.utilizationPercent ?? (cap > 0 ? (observed / cap) * 100 : 0);
        const isTokens = plan.budgetCapTokens != null;
        return (
          <QuotaBar
            key={plan.planIssueId}
            label={plan.title}
            percentUsed={pct}
            leftLabel={`${fmt(isTokens, observed)} / ${fmt(isTokens, cap)}`}
            rightLabel={`${Math.round(pct)}%`}
            showDeficitNotch={pct >= 100}
          />
        );
      })}
    </div>
  );
}

function metricLabel(metric: string): string {
  return metric === "total_tokens" ? "tokens" : "spend";
}
function formatAmount(metric: string, n: number): string {
  return metric === "total_tokens" ? `${formatTokens(n)} tok` : formatCents(n);
}
function fmt(isTokens: boolean, n: number): string {
  return isTokens ? `${formatTokens(n)} tok` : formatCents(n);
}
