import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import type { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { and, eq, isNull } from 'drizzle-orm';
import { boards, db, nid } from '@seed/db';
import { safeParseBoardDocument } from '@seed/shared/board-contract';
import { request as undiciRequest } from 'undici';
import { buildStoryboard, type Storyboard } from './storyboard-model';
import { toInternalAssetUrl } from './storyboard-asset-url';
import { checkRateLimit } from './rate-limit';

export { toInternalAssetUrl } from './storyboard-asset-url';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

/** Default pdfkit fonts are Latin-only (AFM) — Cyrillic needs a real TTF. */
const CYRILLIC_FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const CYRILLIC_FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const FRAME_FETCH_TIMEOUT_MS = 10_000;
// BL-8: bound the unauth amplification. A share link is anonymous and each hit
// fans out one MinIO fetch per card + a PDFKit render; cap the cards rendered
// and the parallel fetches so one oversized board can't blow CPU/bandwidth.
const MAX_STORYBOARD_CARDS = 60;
const FRAME_FETCH_CONCURRENCY = 4;
// Per-share-token and per-IP throttles on the public route (5-min window).
// Maxes are read at request time so deployments (and tests) can tune them.
const STORYBOARD_RATE_WINDOW_SECONDS = 5 * 60;
const storyboardTokenRateMax = (): number => Number(process.env.STORYBOARD_TOKEN_RATE_MAX ?? 30);
const storyboardIpRateMax = (): number => Number(process.env.STORYBOARD_IP_RATE_MAX ?? 60);

/** Map with a bounded concurrency so a 200-card board doesn't open 200 sockets. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

/** Fetch a storyboard frame; null on any failure (the card renders a
 * placeholder box instead — export must never 500 over one bad image). */
async function fetchFrame(url: string): Promise<Buffer | null> {
  try {
    const internalUrl = toInternalAssetUrl(url);
    if (!internalUrl) return null;
    const res = await undiciRequest(internalUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(FRAME_FETCH_TIMEOUT_MS),
    });
    // An aborted/undrained body emits 'error' asynchronously — without a
    // listener that is an uncaught event and KILLS the process.
    (res.body as unknown as EventEmitter).on('error', () => {});
    if (res.statusCode >= 400) {
      await res.body.dump().catch(() => {});
      return null;
    }
    const ct = String(res.headers['content-type'] ?? '');
    if (!/image\/(jpe?g|png)/i.test(ct) && !/\.(jpe?g|png)(\?|$)/i.test(url)) {
      await res.body.dump().catch(() => {});
      return null;
    }
    const buf = Buffer.from(await res.body.arrayBuffer());
    if (buf.byteLength === 0 || buf.byteLength > MAX_FRAME_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

/** Stream the раскадровка PDF for a board into `reply` (hijacked). */
async function renderStoryboardPdf(
  reply: FastifyReply,
  title: string,
  board: Storyboard,
): Promise<void> {
  // BL-8: cap the rendered cards and bound the parallel frame fetches.
  const cards = board.cards.slice(0, MAX_STORYBOARD_CARDS);
  const frames = await mapWithConcurrency(cards, FRAME_FETCH_CONCURRENCY, (c) =>
    c.frameUrl ? fetchFrame(c.frameUrl) : Promise.resolve(null),
  );

  reply.hijack();
  const raw = reply.raw;
  raw.statusCode = 200;
  raw.setHeader('content-type', 'application/pdf');
  raw.setHeader('content-disposition', 'attachment; filename="storyboard.pdf"');

  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  doc.pipe(raw);
  const hasCyr = existsSync(CYRILLIC_FONT);
  if (hasCyr) doc.registerFont('body', CYRILLIC_FONT);
  if (existsSync(CYRILLIC_FONT_BOLD)) doc.registerFont('bold', CYRILLIC_FONT_BOLD);
  const body = hasCyr ? 'body' : 'Helvetica';
  const bold = existsSync(CYRILLIC_FONT_BOLD) ? 'bold' : 'Helvetica-Bold';

  // header
  doc.font(bold).fontSize(16).text(`Раскадровка — ${title}`, { align: 'left' });
  if (board.castNames.length) {
    doc
      .font(body)
      .fontSize(9)
      .fillColor('#666666')
      .text(`Состав: ${board.castNames.join(', ')}`);
  }
  doc.fillColor('#000000').moveDown(0.5);

  // grid: 3 × 2 cards per A4-landscape page
  const COLS = 3;
  const ROWS = 2;
  const M = 36;
  const GAP = 14;
  const pageW = doc.page.width - M * 2;
  const cardW = (pageW - GAP * (COLS - 1)) / COLS;
  const frameH = (cardW * 9) / 16;
  const cardH = frameH + 64;
  const topY = doc.y;

  cards.forEach((card, i) => {
    const slot = i % (COLS * ROWS);
    if (i > 0 && slot === 0) doc.addPage();
    const col = slot % COLS;
    const row = Math.floor(slot / COLS);
    const x = M + col * (cardW + GAP);
    const y = (slot === i ? topY : M) + row * (cardH + GAP);

    // frame (or placeholder)
    const frame = frames[i];
    doc.save();
    doc.rect(x, y, cardW, frameH).clip();
    if (frame) {
      try {
        doc.image(frame, x, y, { cover: [cardW, frameH], align: 'center', valign: 'center' });
      } catch {
        /* corrupt image — leave the placeholder box */
      }
    }
    doc.restore();
    doc
      .rect(x, y, cardW, frameH)
      .lineWidth(0.7)
      .strokeColor(frame ? '#999999' : '#cccccc')
      .stroke();
    if (!frame) {
      doc
        .font(body)
        .fontSize(8)
        .fillColor('#aaaaaa')
        .text('кадр ещё не снят', x, y + frameH / 2 - 4, { width: cardW, align: 'center' });
    }

    // caption
    const meta = [
      `Кадр ${card.index}`,
      `${card.durationSeconds} с`,
      ...(card.grammar ? [card.grammar] : []),
    ].join(' · ');
    doc
      .font(bold)
      .fontSize(9)
      .fillColor('#000000')
      .text(meta, x, y + frameH + 5, { width: cardW });
    if (card.castNames.length) {
      doc
        .font(body)
        .fontSize(7.5)
        .fillColor('#666666')
        .text(card.castNames.join(', '), x, doc.y + 1, { width: cardW });
    }
    doc
      .font(body)
      .fontSize(8)
      .fillColor('#333333')
      .text(card.prompt || '—', x, doc.y + 2, { width: cardW, height: 30, ellipsis: true });
  });

  if (cards.length === 0) {
    doc
      .font(body)
      .fontSize(12)
      .fillColor('#666666')
      .text('На борде пока нет видео-кадров.', { align: 'center' });
  }
  doc.end();
}

/**
 * Раскадровка (previz S5): owner PDF export + read-only share link.
 * GET  /v1/boards/:id/storyboard.pdf — owner export
 * POST /v1/boards/:id/share          — mint (or return) the share token
 * DELETE /v1/boards/:id/share        — revoke
 * GET  /v1/storyboard/:token         — public, read-only PDF by token
 */
export function setupStoryboardRoutes(
  app: FastifyInstance,
  requireSession: SessionResolver,
  opts: { redis?: IORedis } = {},
): void {
  app.get<{ Params: { id: string } }>('/v1/boards/:id/storyboard.pdf', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const [row] = await db
      .select()
      .from(boards)
      .where(
        and(
          eq(boards.id, req.params.id),
          eq(boards.userId, session.user.id),
          isNull(boards.trashedAt),
        ),
      )
      .limit(1);
    if (!row) return reply.status(404).send({ error: 'not_found' });
    const state = safeParseBoardDocument(row.state);
    if (!state.success) {
      req.log.error(
        { boardId: row.id, issues: state.error.issues },
        'storyboard board state invalid',
      );
      return reply.status(500).send({ error: 'invalid_board_state' });
    }
    await renderStoryboardPdf(reply, row.title, buildStoryboard(state.data));
  });

  app.post<{ Params: { id: string } }>('/v1/boards/:id/share', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const [row] = await db
      .select({ id: boards.id, shareToken: boards.shareToken })
      .from(boards)
      .where(
        and(
          eq(boards.id, req.params.id),
          eq(boards.userId, session.user.id),
          isNull(boards.trashedAt),
        ),
      )
      .limit(1);
    if (!row) return reply.status(404).send({ error: 'not_found' });
    if (row.shareToken) return { token: row.shareToken };
    const token = `sb-${nid()}${nid()}`;
    await db.update(boards).set({ shareToken: token }).where(eq(boards.id, row.id));
    return { token };
  });

  app.delete<{ Params: { id: string } }>('/v1/boards/:id/share', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const updated = await db
      .update(boards)
      .set({ shareToken: null })
      .where(
        and(
          eq(boards.id, req.params.id),
          eq(boards.userId, session.user.id),
          isNull(boards.trashedAt),
        ),
      )
      .returning({ id: boards.id });
    if (updated.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.get<{ Params: { token: string } }>('/v1/storyboard/:token', async (req, reply) => {
    // BL-8: this is the unauthenticated amplification surface — throttle per
    // share token AND per client IP before any DB lookup / PDF render.
    if (opts.redis) {
      const ipRl = await checkRateLimit(
        opts.redis,
        `seed:storyboard:ip:${req.ip}`,
        storyboardIpRateMax(),
        STORYBOARD_RATE_WINDOW_SECONDS,
      );
      const tokenRl = await checkRateLimit(
        opts.redis,
        `seed:storyboard:token:${req.params.token}`,
        storyboardTokenRateMax(),
        STORYBOARD_RATE_WINDOW_SECONDS,
      );
      if (!ipRl.allowed || !tokenRl.allowed) {
        return reply.status(429).send({ error: 'rate_limit_exceeded' });
      }
    }
    if (!/^sb-[\w-]{10,}$/.test(req.params.token)) {
      return reply.status(404).send({ error: 'not_found' });
    }
    const [row] = await db
      .select()
      .from(boards)
      .where(and(eq(boards.shareToken, req.params.token), isNull(boards.trashedAt)))
      .limit(1);
    if (!row) return reply.status(404).send({ error: 'not_found' });
    const state = safeParseBoardDocument(row.state);
    if (!state.success) {
      req.log.error(
        { boardId: row.id, issues: state.error.issues },
        'storyboard board state invalid',
      );
      return reply.status(500).send({ error: 'invalid_board_state' });
    }
    await renderStoryboardPdf(reply, row.title, buildStoryboard(state.data));
  });
}
