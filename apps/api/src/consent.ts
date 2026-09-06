import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { consentRecords, db, nid } from '@seed/db';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

/**
 * 152-ФЗ consent (audit M8). The CURRENT required legal documents and their
 * versions. The SERVER stamps the version it is currently serving — the client
 * only asserts "I accept the current set", so a forged version can't be recorded.
 * Bump a version string here whenever the corresponding /legal/* document changes
 * materially; users will then re-consent and a fresh row is written.
 */
export const CONSENT_DOCUMENTS: ReadonlyArray<{ slug: string; version: string }> = [
  { slug: 'offer', version: '2026-06-19' }, // публичная оферта /legal/offer
  { slug: 'aup', version: '2026-06-19' }, // правила использования /legal/aup
  { slug: 'pdn', version: '2026-06-19' }, // согласие на обработку ПДн /legal/consent
];

/** Persist the current required consent set for a user, skipping any already on file. */
export async function recordConsent(
  userId: string,
  ip: string | null,
  ua: string | null,
): Promise<Array<{ slug: string; version: string }>> {
  const recorded: Array<{ slug: string; version: string }> = [];
  for (const doc of CONSENT_DOCUMENTS) {
    const existing = await db
      .select({ id: consentRecords.id })
      .from(consentRecords)
      .where(
        and(
          eq(consentRecords.userId, userId),
          eq(consentRecords.documentSlug, doc.slug),
          eq(consentRecords.documentVersion, doc.version),
        ),
      )
      .limit(1);
    if (existing.length > 0) continue;
    await db.insert(consentRecords).values({
      id: nid(),
      userId,
      documentSlug: doc.slug,
      documentVersion: doc.version,
      ip,
      ua,
    });
    recorded.push(doc);
  }
  return recorded;
}

export function setupConsentRoutes(app: FastifyInstance, requireSession: SessionResolver): void {
  // M8: record server-side proof that the authenticated user accepted the current
  // legal documents. Called by the client right after sign-in. Idempotent: only
  // documents/versions not already on file for the user are written.
  app.post('/v1/consent', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const ua = req.headers['user-agent'] ?? null;
    const recorded = await recordConsent(session.user.id, req.ip ?? null, ua);
    return { ok: true, documents: CONSENT_DOCUMENTS, recorded };
  });
}
