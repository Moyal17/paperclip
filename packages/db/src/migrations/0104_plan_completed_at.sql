-- Plan completion timestamp. Set when a plan transitions to state='completed'
-- (distinct from the root issue status). Nullable: backward-compatible with
-- existing plan rows during rolling deploys.
ALTER TABLE plan_details ADD COLUMN completed_at timestamptz;
