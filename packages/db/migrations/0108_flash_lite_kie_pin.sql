-- Owner ruling 2026-09-02 (O-1 follow-up): gemini-3-1-flash-lite-image sells on
-- LaoZhang at 15.6% while finance signs Kie as нога1 at 32.5% — and Kie is the
-- CHEAPER leg (owner-confirmed, PAID 2026-07-25). Flip the pins; LaoZhang becomes
-- the reserve. Guarded on 0107's exact values so an operator who already re-pinned
-- the row in /admin/models keeps their pin (COALESCE alone cannot express "only if
-- still the O-1 default").
UPDATE "models"
SET "gateway_override" = 'kie',
    "fallback_gateway" = 'laozhang',
    "capabilities" = "capabilities" ||
      '{"priceUsdPerUnit":0.02,"fallbackUsdPerUnit":0.025}'::jsonb
WHERE "id" = 'gemini-3-1-flash-lite-image'
  AND "gateway_override" = 'laozhang'
  AND "fallback_gateway" = 'kie';
