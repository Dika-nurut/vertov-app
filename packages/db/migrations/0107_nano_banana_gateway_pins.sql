-- O-1 (2026-09-02): the 'nanobanana'/'geminiomni' chain aliases stop being routing
-- metadata. The four rows whose chain is a faithful static pair move to explicit
-- gatewayOverride/fallback_gateway pins (identical legs, minus the official leg each
-- row provably never armed); the two exception rows (gemini-3-pro-image: costed
-- official leg + signed single-leg set; gemini-3-1-flash-image: per-rung signed leg
-- order) stay on the alias. COALESCE preserves any admin-set pin from
-- /admin/models, mirroring the seed's conflict guard.
UPDATE "models"
SET "gateway_override" = COALESCE("gateway_override", 'laozhang'),
    "fallback_gateway" = COALESCE("fallback_gateway", 'kie'),
    "capabilities" = "capabilities" - 'forceGateway'
WHERE "id" = 'gemini-2-5-flash-image';

UPDATE "models"
SET "gateway_override" = COALESCE("gateway_override", 'laozhang'),
    "fallback_gateway" = COALESCE("fallback_gateway", 'kie'),
    "capabilities" = "capabilities" - 'forceGateway'
WHERE "id" = 'gemini-3-1-flash-lite-image';

UPDATE "models"
SET "gateway_override" = COALESCE("gateway_override", 'laozhang'),
    "fallback_gateway" = COALESCE("fallback_gateway", 'kie'),
    "capabilities" = "capabilities" - 'forceGateway'
WHERE "id" = 'gpt-image-2';

UPDATE "models"
SET "gateway_override" = COALESCE("gateway_override", 'kie'),
    "fallback_gateway" = COALESCE("fallback_gateway", 'atlascloud'),
    "capabilities" = "capabilities" - 'forceGateway'
WHERE "id" = 'gemini-omni-flash';
