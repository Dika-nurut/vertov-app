-- Approved /pricing (owner 2026-09-25): Старт/Плюс sell «Seedance — Fast», Про and
-- above sell «Seedance — все модели». The catalogue still carried the retired
-- «Креатор» gate on full Seedance 2.0, which opened it at Плюс. Guarded on the old
-- value so an operator's manual pin in /admin/models survives.
--
-- On a fresh database every migration runs in one transaction, so 'pro' (added
-- by 0038) is still uncommitted here and Postgres refuses to use it. Skip in that
-- case: the seed catalogue already carries 'pro' for both rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumtypid = 'public.tier'::regtype
      AND enumlabel = 'pro'
      AND xmin = pg_current_xact_id()::xid
  ) THEN
    RETURN;
  END IF;
  EXECUTE $q$
    UPDATE "models"
    SET "tier_min" = 'pro'
    WHERE "id" IN ('seedance-2-0', 'seedance-2-0-reference-to-video')
      AND "tier_min" = 'creator'
  $q$;
END $$;
