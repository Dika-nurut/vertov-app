import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { creditBuckets, creditPacks, db, orders, subscriptionsCatalog } from '@seed/db';

interface SessionLike {
  user: { id: string };
}
type SessionResolver = (req: FastifyRequest, reply: FastifyReply) => Promise<SessionLike | null>;

const ORG_HEADER = process.env.INVOICE_ORG_HEADER ?? 'Seed — diyor@reflection.rocks';

/** Human-facing provider name for an invoice, including legacy orders. */
export function billingProviderLabel(psp: string): string {
  if (psp === 'tochka') return 'Точка Банк';
  if (psp === 'stars') return 'Telegram Stars';
  return 'ЮKassa';
}

export function setupBillingHistoryRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
): void {
  app.get<{ Querystring: { limit?: string } }>('/v1/billing/history', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit ?? 50) || 50));

    // Outer join so pack + subscription rows resolve their display name
    // in one query. For subscription orders the join falls through to
    // the catalog; for pack orders to credit_packs.
    const rows = await db
      .select({
        id: orders.id,
        kind: orders.kind,
        amountRub: orders.amountRub,
        ourStatus: orders.ourStatus,
        paidAt: orders.paidAt,
        createdAt: orders.createdAt,
        metadata: orders.metadata,
        tierOrPackId: orders.tierOrPackId,
        psp: orders.psp,
        packTitle: creditPacks.title,
        subTitle: subscriptionsCatalog.title,
      })
      .from(orders)
      .leftJoin(creditPacks, eq(creditPacks.id, orders.tierOrPackId))
      .leftJoin(
        subscriptionsCatalog,
        eq(
          subscriptionsCatalog.tier,
          sql`CASE WHEN ${orders.kind} = 'subscription' THEN ${orders.tierOrPackId}::tier ELSE NULL END`,
        ),
      )
      .where(eq(orders.userId, session.user.id))
      .orderBy(desc(orders.createdAt))
      .limit(limit);

    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      amountRub: r.amountRub,
      status: r.ourStatus,
      paidAt: r.paidAt,
      createdAt: r.createdAt,
      title: r.kind === 'pack' ? (r.packTitle ?? r.tierOrPackId) : (r.subTitle ?? r.tierOrPackId),
      purpose:
        r.kind === 'subscription'
          ? ((r.metadata as { purpose?: string } | null)?.purpose ?? null)
          : null,
    }));
  });

  /**
   * Breakdown of where the user's available credits came from. M9 §3.3:
   *   - pack grants never expire
   *   - subscription grants live until the next cycle's reset
   *   - pending = reservations sitting unspent
   *   - refund = total credits returned to the user
   *
   * Bucket residuals are the balance authority. The ledger is lifetime audit
   * history, so it cannot answer what is still available.
   */
  app.get('/v1/billing/credit-breakdown', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;

    const live = or(isNull(creditBuckets.expiresAt), sql`${creditBuckets.expiresAt} > now()`);
    const residual = sql<number>`${creditBuckets.granted} - ${creditBuckets.reserved} - ${creditBuckets.consumed}`;

    const [subscriptionGrant] = await db
      .select({
        amount: sql<number>`COALESCE(SUM(${residual}), 0)::int`,
        expiresAt: sql<Date | null>`MIN(${creditBuckets.expiresAt})`,
      })
      .from(creditBuckets)
      .where(
        and(
          eq(creditBuckets.userId, session.user.id),
          eq(creditBuckets.origin, 'subscription'),
          live,
          sql`${residual} > 0`,
        ),
      );

    // Per-pack residuals so the UI can show "150 from Стартовый on 2026-05-27".
    const packRows = await db
      .select({
        packId: orders.tierOrPackId,
        grantedAt: creditBuckets.createdAt,
        amount: residual,
        expiresAt: creditBuckets.expiresAt,
      })
      .from(creditBuckets)
      .innerJoin(orders, eq(orders.id, creditBuckets.relatedOrderId))
      .where(
        and(
          eq(creditBuckets.userId, session.user.id),
          eq(creditBuckets.origin, 'pack'),
          sql`${residual} > 0`,
        ),
      )
      .orderBy(desc(creditBuckets.createdAt));

    const [pending] = await db
      .select({ amount: sql<number>`COALESCE(SUM(${creditBuckets.reserved}), 0)::int` })
      .from(creditBuckets)
      .where(eq(creditBuckets.userId, session.user.id));

    const [refund] = await db
      .select({ amount: sql<number>`COALESCE(SUM(${residual}), 0)::int` })
      .from(creditBuckets)
      .where(and(eq(creditBuckets.userId, session.user.id), eq(creditBuckets.origin, 'refund')));

    return {
      subscriptionGrant: {
        amount: Number(subscriptionGrant?.amount ?? 0),
        expiresAt: subscriptionGrant?.expiresAt ?? null,
      },
      packGrant: packRows.map((p) => ({
        packId: p.packId,
        amount: Number(p.amount),
        grantedAt: p.grantedAt,
        expiresAt: p.expiresAt,
      })),
      pending: Number(pending?.amount ?? 0),
      refund: Number(refund?.amount ?? 0),
    };
  });

  /**
   * Stream a PDF invoice. 404 if the order isn't the caller's, isn't paid,
   * or doesn't exist. Russian copy, ₽ amount, and the provider recorded on the order
   * footer. Filename `invoice-${shortOrderId}.pdf`.
   */
  app.get<{ Params: { orderId: string } }>(
    '/v1/billing/invoice/:orderId.pdf',
    async (req, reply) => {
      const session = await requireSession(req, reply);
      if (!session) return;

      // The Fastify route param strips `.pdf` itself — we declared the URL
      // template with `.pdf` so it routes only PDF requests, but the
      // captured `:orderId` includes `.pdf`. Strip it defensively.
      const raw = req.params.orderId;
      const orderId = raw.endsWith('.pdf') ? raw.slice(0, -4) : raw;

      const rows = await db
        .select({
          id: orders.id,
          kind: orders.kind,
          amountRub: orders.amountRub,
          paidAt: orders.paidAt,
          createdAt: orders.createdAt,
          tierOrPackId: orders.tierOrPackId,
          psp: orders.psp,
          ourStatus: orders.ourStatus,
          userId: orders.userId,
          packTitle: creditPacks.title,
          subTitle: subscriptionsCatalog.title,
        })
        .from(orders)
        .leftJoin(creditPacks, eq(creditPacks.id, orders.tierOrPackId))
        .leftJoin(
          subscriptionsCatalog,
          eq(
            subscriptionsCatalog.tier,
            sql`CASE WHEN ${orders.kind} = 'subscription' THEN ${orders.tierOrPackId}::tier ELSE NULL END`,
          ),
        )
        .where(eq(orders.id, orderId))
        .limit(1);
      const order = rows[0];
      if (!order || order.userId !== session.user.id || order.ourStatus !== 'paid') {
        return reply.status(404).send({ error: 'not_found' });
      }
      const title =
        order.kind === 'pack'
          ? (order.packTitle ?? `Пакет ${order.tierOrPackId}`)
          : (order.subTitle ?? `Подписка ${order.tierOrPackId}`);
      const shortId = order.id.slice(0, 8);

      // Hijack so we can write the PDF stream directly to the raw response.
      reply.hijack();
      const raw2 = reply.raw;
      raw2.statusCode = 200;
      raw2.setHeader('content-type', 'application/pdf');
      raw2.setHeader('content-disposition', `attachment; filename="invoice-${shortId}.pdf"`);

      const doc = new PDFDocument({ size: 'A4', margin: 50 });
      doc.pipe(raw2);
      doc.fontSize(18).text(ORG_HEADER, { align: 'left' });
      doc.moveDown();
      doc.fontSize(12);
      doc.text(`Счёт №: ${order.id}`);
      doc.text(`Дата: ${(order.paidAt ?? order.createdAt).toISOString().slice(0, 10)}`);
      doc.moveDown();
      doc.fontSize(14).text('Позиция', { underline: true });
      doc.fontSize(12).text(title);
      doc.moveDown();
      doc.fontSize(14).text('Сумма', { underline: true });
      doc.fontSize(16).text(`${order.amountRub.toLocaleString('ru-RU')} RUB`);
      doc.moveDown(2);
      doc
        .fontSize(10)
        .text(`Оплата проведена через ${billingProviderLabel(order.psp)}`, { align: 'right' });
      doc.end();
      return;
    },
  );
}
