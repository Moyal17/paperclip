// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { PlanDetailDrawer } from "./PlanDetailDrawer";
import { plansApi } from "../../api/plans";

vi.mock("@/lib/router", () => ({
  useSearchParams: () => [new URLSearchParams("plan=plan-1"), vi.fn()],
}));
vi.mock("../../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));
vi.mock("./PlanGateRollup", () => ({ PlanGateRollup: () => null }));
vi.mock("../../api/plans", () => ({
  plansApi: { get: vi.fn(), complete: vi.fn() },
}));

function planResponse(state: string) {
  return {
    issue: { id: "plan-1", title: "Pilot plan", description: null },
    planDetails: {
      issueId: "plan-1",
      state,
      tiers: [],
      budgetCapTokens: null,
    },
    childStatuses: [],
  };
}

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <PlanDetailDrawer companyId="company-1" />
        </TooltipProvider>
      </QueryClientProvider>,
    );
  });
  // Let the plan query resolve (poll until the loading placeholder clears).
  for (let i = 0; i < 50 && document.body.textContent?.includes("Loading…"); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
    flushSync(() => {});
  }
  return root;
}

describe("PlanDetailDrawer — Complete plan action", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the Complete plan button for an active plan", async () => {
    (plansApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(planResponse("active"));
    const root = await render();
    expect(document.body.textContent).toContain("Complete plan");
    flushSync(() => root.unmount());
  });

  it("shows the Complete plan button for a stopped plan", async () => {
    (plansApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(planResponse("stopped"));
    const root = await render();
    expect(document.body.textContent).toContain("Complete plan");
    flushSync(() => root.unmount());
  });

  it("hides the Complete plan button for a draft plan", async () => {
    (plansApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(planResponse("draft"));
    const root = await render();
    expect(document.body.textContent).not.toContain("Complete plan");
    flushSync(() => root.unmount());
  });

  it("calls plansApi.complete when the button is clicked", async () => {
    (plansApi.get as ReturnType<typeof vi.fn>).mockResolvedValue(planResponse("active"));
    (plansApi.complete as ReturnType<typeof vi.fn>).mockResolvedValue({
      planDetails: planResponse("completed").planDetails,
      retrospectiveDocument: { document: { id: "d1", key: "plan-retrospective", title: null, body: "x" }, created: true },
    });
    const root = await render();
    const button = [...document.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Complete plan"),
    );
    expect(button).toBeTruthy();
    flushSync(() => button!.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await new Promise((r) => setTimeout(r, 0));
    expect(plansApi.complete).toHaveBeenCalledWith("plan-1");
    flushSync(() => root.unmount());
  });
});
