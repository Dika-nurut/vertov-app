-- Seedance 2.0 Mini goes on sale. Paid smoke 2026-09-25: three 480p 4 s clips, each
-- delivered 4.096 s, billed 5 s at $0.07 = $0.014/s — the Pixazo quote the rev. 23
-- workbook rows (36 / 77 credits per 5 s) were signed on. Record:
-- docs/evidence/model-catalog/2026-09-25-seedance-mini-pixazo.md
UPDATE "models" SET "is_active" = true WHERE "id" = 'seedance-2-0-mini';
--> statement-breakpoint
UPDATE "model_price_points" SET "is_active" = true
WHERE "model_id" = 'seedance-2-0-mini' AND "resolution" = '480p' AND "video_input" = false AND "audio" = false AND "mode" = 'any' AND "refs_min" = 0;
--> statement-breakpoint
UPDATE "model_price_points" SET "is_active" = true
WHERE "model_id" = 'seedance-2-0-mini' AND "resolution" = '720p' AND "video_input" = false AND "audio" = false AND "mode" = 'any' AND "refs_min" = 0;
