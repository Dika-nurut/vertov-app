import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db, marketingAttribution } from '@seed/db';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; isAnonymous?: boolean | null } } | null>;

/**
 * POST /v1/me/attribution — first-touch UTM capture (funnel spec §5).
 * Idempotent by design: only inserts if the user has no row yet.
 * Never updates an existing row — first-touch wins permanently.
 * No PII beyond what the visitor already carried in the URL/referrer.
 */
const attributionSchema = z.object({
  utmSource: z.string().max(500).optional(),
  utmMedium: z.string().max(500).optional(),
  utmCampaign: z.string().max(500).optional(),
  referrer: z.string().max(2000).optional(),
  landingPath: z.string().max(1000).optional(),
});

export function setupMeAttributionRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
): void {
  app.post('/v1/me/attribution', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    // Anonymous browsing has a session identity for draft persistence, but it
    // is not a business user and is deleted/claimed during signup. Keep the
    // client-side first-touch payload for the eventual real account instead
    // of creating an attribution row that the human funnel excludes.
    if (session.user.isAnonymous) return { ok: true, skipped: 'anonymous' as const };
    const parsed = attributionSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    // ON CONFLICT DO NOTHING = first-touch wins. A repeat POST is a no-op.
    await db
      .insert(marketingAttribution)
      .values({
        userId: session.user.id,
        utmSource: parsed.data.utmSource ?? null,
        utmMedium: parsed.data.utmMedium ?? null,
        utmCampaign: parsed.data.utmCampaign ?? null,
        referrer: parsed.data.referrer ?? null,
        landingPath: parsed.data.landingPath ?? null,
      })
      .onConflictDoNothing();
    return { ok: true };
  });

  app.get('/v1/me/attribution', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const [row] = await db
      .select()
      .from(marketingAttribution)
      .where(eq(marketingAttribution.userId, session.user.id))
      .limit(1);
    return { attribution: row ?? null };
  });
}
