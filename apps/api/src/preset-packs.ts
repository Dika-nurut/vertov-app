import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { db, models, presetPacks } from '@seed/db';
import { publicFeedRateLimit } from './public-rate-limits';

const CATEGORIES = ['scene', 'camera', 'effect', 'style'] as const;

/**
 * GET /v1/preset-packs?lang=ru|en&category=scene|camera|effect|style
 *
 * Returns all active preset packs for the requested locale, optionally
 * filtered by catalog category, ordered by sortOrder. Defaults to `ru`.
 *
 * GET /v1/preset-packs/:slug?lang=… — single pack lookup for the
 * /generate?preset=<slug> prefill.
 */
export function setupPresetPacksRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { lang?: string; category?: string } }>(
    '/v1/preset-packs',
    { config: publicFeedRateLimit() },
    async (req, reply) => {
      const lang = req.query.lang === 'en' ? 'en' : 'ru';
      const filters = [eq(presetPacks.isActive, true), eq(presetPacks.locale, lang)];
      if (req.query.category) {
        if (!(CATEGORIES as readonly string[]).includes(req.query.category)) {
          return reply.status(400).send({ error: 'invalid_category' });
        }
        filters.push(eq(presetPacks.category, req.query.category));
      }
      const rows = await db
        .select({
          pack: presetPacks,
          model: {
            family: models.family,
            variant: models.variant,
            displayName: models.displayName,
          },
        })
        .from(presetPacks)
        .leftJoin(models, eq(models.id, presetPacks.modelId))
        .where(and(...filters))
        .orderBy(asc(presetPacks.sortOrder));
      return {
        items: rows.map(({ pack, model }) => ({
          ...pack,
          model: model?.family && model.variant ? model : null,
        })),
      };
    },
  );

  app.get<{ Params: { slug: string }; Querystring: { lang?: string } }>(
    '/v1/preset-packs/:slug',
    { config: publicFeedRateLimit() },
    async (req, reply) => {
      const lang = req.query.lang === 'en' ? 'en' : 'ru';
      const rows = await db
        .select({
          pack: presetPacks,
          model: {
            family: models.family,
            variant: models.variant,
            displayName: models.displayName,
          },
        })
        .from(presetPacks)
        .leftJoin(models, eq(models.id, presetPacks.modelId))
        .where(
          and(
            eq(presetPacks.slug, req.params.slug),
            eq(presetPacks.locale, lang),
            eq(presetPacks.isActive, true),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return reply.status(404).send({ error: 'not_found' });
      return {
        ...row.pack,
        model: row.model?.family && row.model.variant ? row.model : null,
      };
    },
  );
}
