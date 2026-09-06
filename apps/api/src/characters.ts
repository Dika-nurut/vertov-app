import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { characters, db, nid } from '@seed/db';

type SessionResolver = (
  req: FastifyRequest,
  reply: FastifyReply,
) => Promise<{ user: { id: string } } | null>;

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  imageUrls: z.array(z.string().url()).min(1).max(4),
});

const MAX_CHARACTERS = 24;

/**
 * «Персонажи» — named reference-image sets for character consistency.
 * Pure CRUD; applying a character is a client-side action (inject its
 * imageUrls into the generate screen's reference pool).
 */
export function setupCharacterRoutes(app: FastifyInstance, requireSession: SessionResolver): void {
  app.get('/v1/characters', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const rows = await db
      .select()
      .from(characters)
      .where(eq(characters.userId, session.user.id))
      .orderBy(desc(characters.createdAt))
      .limit(MAX_CHARACTERS);
    return { items: rows };
  });

  app.post('/v1/characters', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const countRows = await db
      .select({ id: characters.id })
      .from(characters)
      .where(eq(characters.userId, session.user.id));
    if (countRows.length >= MAX_CHARACTERS) {
      return reply.status(400).send({ error: 'too_many_characters', max: MAX_CHARACTERS });
    }
    const id = nid();
    const [row] = await db
      .insert(characters)
      .values({
        id,
        userId: session.user.id,
        name: parsed.data.name,
        imageUrls: parsed.data.imageUrls,
      })
      .returning();
    return reply.status(201).send(row);
  });

  app.delete<{ Params: { id: string } }>('/v1/characters/:id', async (req, reply) => {
    const session = await requireSession(req, reply);
    if (!session) return;
    const deleted = await db
      .delete(characters)
      .where(and(eq(characters.id, req.params.id), eq(characters.userId, session.user.id)))
      .returning({ id: characters.id });
    if (deleted.length === 0) return reply.status(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
