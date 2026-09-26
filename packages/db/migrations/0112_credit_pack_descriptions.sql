-- Pack descriptions named Veo Fast and Seedream 5.0, which need Плюс (tierMin
-- `creator`), while packs are sold to any live plan including Старт. Rewrite
-- them with models Старт unlocks, counted from the active price points.
-- Data-only and idempotent; mirrors packages/db/seed/credit-packs.ts.
UPDATE "credit_packs" SET "description" = '≈7 видео Veo Lite или 29 фото Nano Banana 2.' WHERE "id" = 'pack-s';
UPDATE "credit_packs" SET "description" = '≈22 видео Veo Lite или 88 фото Nano Banana 2.' WHERE "id" = 'pack-m';
UPDATE "credit_packs" SET "description" = '≈60 видео Veo Lite или 235 фото Nano Banana 2.' WHERE "id" = 'pack-l';
UPDATE "credit_packs" SET "description" = '≈151 видео Veo Lite или 588 фото Nano Banana 2.' WHERE "id" = 'pack-xl';
UPDATE "credit_packs" SET "description" = '≈378 видео Veo Lite или 1 470 фото Nano Banana 2.' WHERE "id" = 'pack-xxl';
