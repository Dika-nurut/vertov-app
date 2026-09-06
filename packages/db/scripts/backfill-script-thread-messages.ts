import 'dotenv/config';
import { pool } from '../src/index';

/**
 * Expand/contract migration helper for Scenario conversations. It is safe to
 * run repeatedly: legacy row ids are deterministic (`legacy:<thread>:<n>`) and
 * the primary-key conflict turns every subsequent run into a no-op.
 *
 * Keep `script_threads.messages` intact until the web client has used the
 * paginated ledger in production and rollback no longer needs the JSON field.
 */
const result = await pool.query<{ inserted: string }>(`
  WITH legacy AS (
    SELECT
      'legacy:' || t.id || ':' || item.ordinality::text AS id,
      t.id AS thread_id,
      t.script_id,
      t.user_id,
      CASE WHEN item.message->>'role' IN ('user', 'assistant')
        THEN item.message->>'role' ELSE 'assistant' END AS role,
      COALESCE(item.message->>'content', '') AS content,
      CASE WHEN jsonb_typeof(item.message->'proposal') = 'object'
        THEN item.message->'proposal' ELSE NULL END AS proposal,
      NULLIF(item.message->>'tier', '') AS tier,
      CASE WHEN COALESCE(item.message->>'at', '') ~
        '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}'
        THEN (item.message->>'at')::timestamptz
        ELSE t.created_at + ((item.ordinality - 1) * interval '1 microsecond') END AS created_at
    FROM script_threads t
    CROSS JOIN LATERAL jsonb_array_elements(t.messages) WITH ORDINALITY AS item(message, ordinality)
    WHERE jsonb_typeof(t.messages) = 'array'
  ), inserted AS (
    INSERT INTO script_thread_messages
      (id, thread_id, script_id, user_id, role, content, proposal, tier, created_at)
    SELECT id, thread_id, script_id, user_id, role, content, proposal, tier, created_at
    FROM legacy
    ON CONFLICT (id) DO NOTHING
    RETURNING id
  )
  SELECT COUNT(*)::text AS inserted FROM inserted
`);

console.log(`scenario thread-message backfill: ${result.rows[0]?.inserted ?? '0'} inserted`);
await pool.end();
