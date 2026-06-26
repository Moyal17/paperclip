-- Raise company-scope total_tokens budget cap to 150M tokens.
-- Also patches the instance_settings guards so new companies get 150M.
UPDATE budget_policies
SET amount = 150000000, updated_at = NOW()
WHERE scope_type = 'company'
  AND metric = 'total_tokens'
  AND is_active = true;
--> statement-breakpoint
UPDATE instance_settings
SET guards = jsonb_set(
      COALESCE(guards, '{}'),
      '{budget,companyMonthlyTokens}',
      '150000000'
    ),
    updated_at = NOW();
