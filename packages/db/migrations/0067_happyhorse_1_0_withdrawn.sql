-- HappyHorse 1.0 leaves the picker (finance ruling Q8, 2026-08-04).
--
-- 1.0 costs 32.6% more than 1.1 for the same output and has no second leg, and we do
-- not charge more for an older version of the same model. 1.1 covers text-to-video,
-- image-to-video and reference-to-video at both rungs, cheaper — nothing is lost.
--
-- The harder reason: the price export no longer carries a t2v row for 1.0, only the two
-- video-edit rows (720p 284, 1080p 487). A live model whose selected mode has no signed
-- price is the middle state — a picker offering what the price table does not price.
-- Video-edit is the only mode 1.0 serves that 1.1 does not, and there is no
-- `happyhorse-1-0-video-edit` entry to attach those prices to yet.
--
-- The price rows stay in place rather than being deleted: the charge path gates on the
-- MODEL being active, so they are already unreachable, and the day a video-edit entry
-- exists the prices are there and already correct.

UPDATE "models" SET "is_active" = false WHERE "id" = 'happyhorse-1-0';
