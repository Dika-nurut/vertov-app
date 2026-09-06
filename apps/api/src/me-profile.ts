import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  boards,
  characters,
  consentRecords,
  creditBucketAllocations,
  creditBuckets,
  creditTransactions,
  freeGrantEvents,
  db,
  galleryItems,
  jobs,
  lockMediaStorageUser,
  orders,
  schema,
  studioProjects,
  studioRenders,
  subscriptions,
  usersApp,
  usersPii,
} from '@seed/db';
import { CreditService } from '@seed/credits';

const onboardedSchema = z.object({
  answers: z.record(z.unknown()).optional().default({}),
});

/**
 * /v1/me/profile + DELETE /v1/me — W2.Sat.
 *
 * The delete path is the hardest piece: 152-ФЗ requires honouring
 * PII deletion, but the credit_transactions and jobs tables FK into
 * users_app and we want to keep them around for ledger integrity.
 * Hence: soft-delete users_app (status='deleted', display_name
 * cleared, deleted_at stamped) and HARD-delete users_pii. Then
 * refund every open pending ledger row, cancel any live
 * subscription, and wipe sessions.
 */

const patchProfileSchema = z.object({
  displayName: z
    .string()
    .min(1)
    .max(64)
    .transform((s) => s.trim())
    .refine((s) => s.length >= 1, 'displayName cannot be blank'),
  locale: z.enum(['ru', 'en']),
});

const localeSchema = z.object({
  locale: z.enum(['ru', 'en']),
});

// M9: accounts created via anonymous / phone-OTP (sentinel email) / VK-without-email
// have no usable email to confirm against, so accept a typed phrase instead.
const DELETE_CONFIRM_PHRASE = 'УДАЛИТЬ';
const PHONE_SENTINEL_SUFFIX = '@phone.vertov.local';
const deleteSchema = z.object({
  confirmEmail: z.string().email().optional(),
  confirmPhrase: z.string().optional(),
});

type RequireSession = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string; email: string | null } } | null>;

export function setupMeProfileRoutes(
  app: FastifyInstance,
  requireSession: RequireSession,
  credits: CreditService,
): void {
  app.get('/v1/me/profile', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const rows = await db
      .select({
        displayName: usersApp.displayName,
        locale: usersApp.locale,
        tier: usersApp.tier,
        createdAt: usersApp.createdAt,
        email: usersPii.email,
        onboardedAt: usersApp.onboardedAt,
        onboardingAnswers: usersApp.onboardingAnswers,
      })
      .from(usersApp)
      .leftJoin(usersPii, eq(usersPii.id, usersApp.id))
      .where(eq(usersApp.id, session.user.id))
      .limit(1);
    const row = rows[0];
    if (!row) return reply.status(404).send({ error: 'not_found' });
    // No `?? session.user.email` fallback: after DELETE /v1/me the
    // users_pii row is gone (152-ФЗ) but the session can briefly
    // outlive it; falling back would leak the very email we just
    // purged.
    return {
      displayName: row.displayName,
      locale: row.locale,
      tier: row.tier,
      email: row.email,
      createdAt: row.createdAt,
      onboardedAt: row.onboardedAt ?? null,
      onboardingAnswers: row.onboardingAnswers ?? null,
    };
  });

  app.post('/v1/me/onboarded', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    // Idempotent: if already onboarded, return existing timestamp without updating.
    const existing = await db
      .select({ onboardedAt: usersApp.onboardedAt })
      .from(usersApp)
      .where(eq(usersApp.id, session.user.id))
      .limit(1);
    const existingRow = existing[0];
    if (existingRow?.onboardedAt) {
      return { onboardedAt: existingRow.onboardedAt };
    }

    const parsed = onboardedSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }

    const now = new Date();
    await db
      .update(usersApp)
      .set({ onboardedAt: now, onboardingAnswers: parsed.data.answers })
      .where(and(eq(usersApp.id, session.user.id), sql`"onboarded_at" IS NULL`));

    // Re-fetch in case a concurrent request won the race.
    const updated = await db
      .select({ onboardedAt: usersApp.onboardedAt })
      .from(usersApp)
      .where(eq(usersApp.id, session.user.id))
      .limit(1);
    return { onboardedAt: updated[0]?.onboardedAt ?? now };
  });

  /**
   * POST /v1/me/locale
   * Body: { locale: 'ru' | 'en' }
   *
   * Single-purpose locale endpoint so the LanguageToggle + settings dropdown
   * can update the DB column without patching the whole profile. The response
   * includes the accepted locale so the client can update cookie + URL param
   * in one round-trip. (#11 audit — unified locale source of truth)
   */
  app.post('/v1/me/locale', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = localeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    await db
      .update(usersApp)
      .set({ locale: parsed.data.locale })
      .where(eq(usersApp.id, session.user.id));
    return { ok: true, locale: parsed.data.locale };
  });

  app.patch('/v1/me/profile', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = patchProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    await db
      .update(usersApp)
      .set({ displayName: parsed.data.displayName, locale: parsed.data.locale })
      .where(eq(usersApp.id, session.user.id));
    return { ok: true };
  });

  /**
   * GET /v1/me/export — 152-ФЗ / GDPR right-of-access (data portability).
   *
   * Deletion (DELETE /v1/me) and export are the two halves of data-subject
   * rights; the law that requires us to erase PII also requires us to hand it
   * back on request. Returns the authenticated user's profile + own records as
   * a single JSON download. Read-only and strictly `userId`-scoped (INV-4: no
   * IDOR), and `no-store` because the payload is personal data.
   */
  app.get('/v1/me/export', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const userId = session.user.id;

    const profileRows = await db
      .select({
        id: usersApp.id,
        displayName: usersApp.displayName,
        locale: usersApp.locale,
        tier: usersApp.tier,
        status: usersApp.status,
        createdAt: usersApp.createdAt,
        onboardedAt: usersApp.onboardedAt,
        onboardingAnswers: usersApp.onboardingAnswers,
        email: usersPii.email,
      })
      .from(usersApp)
      .leftJoin(usersPii, eq(usersPii.id, usersApp.id))
      .where(eq(usersApp.id, userId))
      .limit(1);
    const profile = profileRows[0];
    if (!profile) return reply.status(404).send({ error: 'not_found' });

    // Every user-linked record table, scoped to their id. Keep this enumeration
    // in lockstep with the schema; financial records are retained on erasure.
    const [
      jobRows,
      galleryRows,
      orderRows,
      subscriptionRows,
      studioProjectRows,
      studioRenderRows,
      boardRows,
      characterRows,
      creditRows,
      creditBucketRows,
      creditBucketAllocationRows,
      freeGrantEventRows,
      consentRows,
    ] = await Promise.all([
      db.select().from(jobs).where(eq(jobs.userId, userId)),
      db.select().from(galleryItems).where(eq(galleryItems.userId, userId)),
      db.select().from(orders).where(eq(orders.userId, userId)),
      db.select().from(subscriptions).where(eq(subscriptions.userId, userId)),
      db.select().from(studioProjects).where(eq(studioProjects.userId, userId)),
      db.select().from(studioRenders).where(eq(studioRenders.userId, userId)),
      db.select().from(boards).where(eq(boards.userId, userId)),
      db.select().from(characters).where(eq(characters.userId, userId)),
      db.select().from(creditTransactions).where(eq(creditTransactions.userId, userId)),
      db.select().from(creditBuckets).where(eq(creditBuckets.userId, userId)),
      db.select().from(creditBucketAllocations).where(eq(creditBucketAllocations.userId, userId)),
      db.select().from(freeGrantEvents).where(eq(freeGrantEvents.userId, userId)),
      db.select().from(consentRecords).where(eq(consentRecords.userId, userId)),
    ]);

    const balance = await credits.balanceFor(userId);

    reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', `attachment; filename="vertov-data-export-${userId}.json"`)
      .header('cache-control', 'no-store');

    return {
      exportedAt: new Date().toISOString(),
      schemaVersion: 1,
      profile,
      balance,
      records: {
        jobs: jobRows,
        gallery: galleryRows,
        orders: orderRows,
        subscriptions: subscriptionRows,
        studioProjects: studioProjectRows,
        studioRenders: studioRenderRows,
        boards: boardRows,
        characters: characterRows,
        creditTransactions: creditRows,
        creditBuckets: creditBucketRows,
        creditBucketAllocations: creditBucketAllocationRows,
        freeGrantEvents: freeGrantEventRows,
        consentRecords: consentRows,
      },
    };
  });

  app.delete('/v1/me', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = deleteSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    // M9: pick the confirmation modality by what the account actually has. An
    // email account confirms by retyping its email; an email-less account
    // (anonymous / phone-OTP sentinel / VK-without-email) confirms with a typed
    // phrase — otherwise right-to-erasure is impossible for those users.
    const rawEmail = (session.user.email ?? '').toLowerCase();
    const hasUsableEmail = rawEmail !== '' && !rawEmail.endsWith(PHONE_SENTINEL_SUFFIX);
    if (hasUsableEmail) {
      // RFC-5321 §2.3.11: local-parts are technically case-sensitive, but every
      // modern provider treats them as case-insensitive, and forcing exact casing
      // is a UX trap.
      if ((parsed.data.confirmEmail ?? '').toLowerCase() !== rawEmail) {
        return reply.status(400).send({ error: 'email_mismatch' });
      }
    } else if ((parsed.data.confirmPhrase ?? '').trim().toUpperCase() !== DELETE_CONFIRM_PHRASE) {
      return reply
        .status(400)
        .send({ error: 'confirm_phrase_mismatch', phrase: DELETE_CONFIRM_PHRASE });
    }

    const userId = session.user.id;

    await db.transaction(async (tx) => {
      // Serialize erasure with worker completion and subscription/media
      // mutations. The same advisory lock is held before those paths insert
      // gallery rows, so no in-flight generation can publish after this
      // transaction marks the account deleted.
      await lockMediaStorageUser(tx, userId);

      // 1. Refund every still-open job's reservation. We compute open
      //    jobs from the canonical source (queued + running with a
      //    non-zero reservation) rather than scanning credit rows.
      const openJobs = await tx
        .select({ id: jobs.id, creditsReserved: jobs.creditsReserved })
        .from(jobs)
        .where(and(eq(jobs.userId, userId), inArray(jobs.status, ['queued', 'running'])));
      for (const j of openJobs) {
        if (j.creditsReserved <= 0) continue;
        await credits.refund({
          userId,
          jobId: j.id,
          amount: j.creditsReserved,
          reason: 'user.deleted',
          idempotencyKey: `user-delete:${userId}:${j.id}`,
          tx,
        });
        await tx
          .update(jobs)
          .set({
            status: 'failed',
            errorCode: 'USER_DELETED',
            errorMessage: 'Account deleted by user.',
            finishedAt: sql`now()`,
          })
          .where(eq(jobs.id, j.id));
      }

      // 2. Cancel any live subscription. Period-end cleanup happens in
      //    the subscription engine later — for now flipping the status
      //    is enough to halt auto-renewal logic.
      await tx
        .update(subscriptions)
        .set({ status: 'canceled', cancelAtPeriodEnd: true })
        .where(
          and(
            eq(subscriptions.userId, userId),
            inArray(subscriptions.status, ['trialing', 'active', 'past_due']),
          ),
        );

      const erasedAt = new Date();

      // Better Auth's verification table intentionally has no user FK. Remove
      // only identifiers we can prove belong to this account: our profile
      // email-change namespace plus the old email/phone identifiers used by
      // the auth OTP/magic-link plugins. This keeps pending codes and their
      // embedded destination email out of post-erasure storage without
      // touching another user's verification rows.
      const piiContact = await tx
        .select({ email: usersPii.email, phone: usersPii.phone })
        .from(usersPii)
        .where(eq(usersPii.id, userId))
        .limit(1);
      const verificationIdentifiers = [
        `email-change:${userId}`,
        session.user.email,
        session.user.email?.toLowerCase(),
        piiContact[0]?.email,
        piiContact[0]?.email?.toLowerCase(),
        piiContact[0]?.phone,
      ].filter((value): value is string => Boolean(value && value.length > 0));
      if (verificationIdentifiers.length > 0) {
        await tx
          .delete(schema.verification)
          .where(inArray(schema.verification.identifier, [...new Set(verificationIdentifiers)]));
      }

      // Cancel queued/running Studio renders before they can publish a fresh
      // gallery row after this transaction. A running worker observes the
      // canceled status at its next checkpoint and cleans any uploaded bytes.
      await tx
        .update(studioRenders)
        .set({ status: 'canceled', errorMessage: 'Account deleted by user.', finishedAt: erasedAt })
        .where(
          and(
            eq(studioRenders.userId, userId),
            inArray(studioRenders.status, ['queued', 'running']),
          ),
        );

      // Revoke read-only Board share links as part of the same privacy
      // boundary. The board row is retained for the ledger/export history, but
      // its public token must not survive account erasure.
      await tx.update(boards).set({ shareToken: null }).where(eq(boards.userId, userId));

      // 3. Revoke every public media surface immediately. Keep the row only as
      // a durable erasure receipt until the gallery reaper removes its object;
      // setting expiresAt also gives the reaper a deterministic cleanup target.
      await tx
        .update(galleryItems)
        .set({
          isPublic: false,
          publishedAt: null,
          publicSlug: null,
          featuredAt: null,
          deletedAt: erasedAt,
          expiresAt: erasedAt,
        })
        .where(eq(galleryItems.userId, userId));

      // 4. Soft-delete users_app, hard-delete users_pii (152-ФЗ).
      await tx
        .update(usersApp)
        .set({ status: 'deleted', displayName: null, deletedAt: sql`now()` })
        .where(eq(usersApp.id, userId));
      await tx.delete(usersPii).where(eq(usersPii.id, userId));

      // 5. Hard-delete the Better Auth `user` row — its `email` and
      //    `name` columns are PII too. `session` and `account` both
      //    cascade ON DELETE so they're wiped in the same statement.
      await tx.delete(schema.user).where(eq(schema.user.id, userId));
    });

    // 6. Clear the session cookie on the client. We don't reach into
    //    auth.api.signOut here — the underlying session row was
    //    deleted in the tx above (cascading from schema.user), so
    //    Better Auth would 404 on any cache miss anyway. We just
    //    emit Set-Cookie headers with Max-Age=0 for the two cookie
    //    names Better Auth could be using.
    const clear = 'Max-Age=0; Path=/; HttpOnly; SameSite=Lax';
    reply.header('set-cookie', [
      `better-auth.session_token=; ${clear}`,
      `__Secure-better-auth.session_token=; ${clear}; Secure`,
    ]);

    return { ok: true };
  });
}
