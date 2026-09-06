UPDATE gallery_items
SET expires_at = LEAST(expires_at + interval '23 days', now() + interval '30 days')
WHERE expires_at IS NOT NULL AND expires_at > now();--> statement-breakpoint
UPDATE asset_deletion_leases
SET previous_expires_at = LEAST(previous_expires_at + interval '23 days', now() + interval '30 days')
WHERE previous_expires_at IS NOT NULL AND previous_expires_at > now();
