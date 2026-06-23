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

  const companyTokenPolicy = data.policies.find(
    (p) => p.scopeType === "company" && p.metric === "total_tokens",
  );
  const companySpendPolicy = data.policies.find(
    (p) => p.scopeType === "company" && p.metric === "billed_cents",
  );
  const activePlans = data.activePlans.filter((p) => p.budgetCapTokens || p.budgetCapCents);

  if (!companyTokenPolicy && !companySpendPolicy && activePlans.length === 0) {
    return (
      <div className="text-xs text-muted-foreground">
        No budget caps set. Add a per-plan cap to auto-stop runaway spend.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {companyTokenPolicy && (
        <div className="space-y-1">
          <QuotaBar
            label="Company · tokens"
            percentUsed={companyTokenPolicy.utilizationPercent}
            leftLabel={`${formatTokens(companyTokenPolicy.observedAmount)} tok / ${formatTokens(companyTokenPolicy.amount)} tok`}
            rightLabel={`${Math.round(companyTokenPolicy.utilizationPercent)}%`}
            showDeficitNotch={companyTokenPolicy.status === "hard_stop"}
          />
          {companySpendPolicy && (
            <p className="text-[10px] text-muted-foreground tabular-nums">
              Spend: {formatCents(companySpendPolicy.observedAmount)} / {formatCents(companySpendPolicy.amount)}
            </p>
          )}
        </div>
      )}
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

function fmt(isTokens: boolean, n: number): string {
  return isTokens ? `${formatTokens(n)} tok` : formatCents(n);
}
