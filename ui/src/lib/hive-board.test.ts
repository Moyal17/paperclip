import { describe, expect, it } from "vitest";
import type { Issue } from "@paperclipai/shared";
import {
  canDropOnColumn,
  columnForIssue,
  projectIssuesToHiveColumns,
  targetStatusForColumn,
} from "./hive-board";

function issue(partial: Partial<Issue>): Issue {
  return {
    id: partial.id ?? "i1",
    status: partial.status ?? "todo",
    workMode: partial.workMode ?? "agent",
    ...partial,
  } as Issue;
}

describe("columnForIssue", () => {
  it("routes planning issues to the Plans column regardless of status", () => {
    expect(columnForIssue(issue({ workMode: "planning", status: "backlog" }))).toBe("plans");
    expect(columnForIssue(issue({ workMode: "planning", status: "in_progress" }))).toBe("plans");
  });

  it("maps the 7 statuses into the 4 work columns", () => {
    expect(columnForIssue(issue({ status: "backlog" }))).toBe("open");
    expect(columnForIssue(issue({ status: "todo" }))).toBe("open");
    expect(columnForIssue(issue({ status: "in_progress" }))).toBe("in_development");
    expect(columnForIssue(issue({ status: "blocked" }))).toBe("in_development");
    expect(columnForIssue(issue({ status: "in_review" }))).toBe("in_review");
    expect(columnForIssue(issue({ status: "done" }))).toBe("done");
    expect(columnForIssue(issue({ status: "cancelled" }))).toBe("done");
  });
});

describe("projectIssuesToHiveColumns", () => {
  it("splits a plan root from its activated children", () => {
    const cols = projectIssuesToHiveColumns([
      issue({ id: "plan", workMode: "planning", status: "backlog" }),
      issue({ id: "t1", status: "todo" }),
      issue({ id: "t2", status: "in_progress" }),
      issue({ id: "t3", status: "in_review" }),
    ]);
    expect(cols.plans.map((i) => i.id)).toEqual(["plan"]);
    expect(cols.open.map((i) => i.id)).toEqual(["t1"]);
    expect(cols.in_development.map((i) => i.id)).toEqual(["t2"]);
    expect(cols.in_review.map((i) => i.id)).toEqual(["t3"]);
    expect(cols.done).toEqual([]);
  });
});

describe("canDropOnColumn", () => {
  it("allows strictly-forward moves", () => {
    expect(canDropOnColumn("open", "in_development")).toBe(true);
    expect(canDropOnColumn("in_development", "in_review")).toBe(true);
    expect(canDropOnColumn("in_review", "done")).toBe(true);
    expect(canDropOnColumn("open", "done")).toBe(true);
  });

  it("rejects backward and same-column moves", () => {
    expect(canDropOnColumn("in_review", "in_development")).toBe(false);
    expect(canDropOnColumn("done", "open")).toBe(false);
    expect(canDropOnColumn("open", "open")).toBe(false);
  });

  it("locks the Plans column on both sides", () => {
    expect(canDropOnColumn("plans", "open")).toBe(false);
    expect(canDropOnColumn("open", "plans")).toBe(false);
  });
});

describe("targetStatusForColumn", () => {
  it("returns the drop-target status per column", () => {
    expect(targetStatusForColumn("open")).toBe("todo");
    expect(targetStatusForColumn("in_development")).toBe("in_progress");
    expect(targetStatusForColumn("in_review")).toBe("in_review");
    expect(targetStatusForColumn("done")).toBe("done");
    expect(targetStatusForColumn("plans")).toBeNull();
  });
});
