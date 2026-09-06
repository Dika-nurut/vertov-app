import { z } from 'zod';

const cursorSchema = z
  .object({
    v: z.literal(1),
    scope: z.enum(['scripts', 'boards', 'studio', 'gallery']),
    ownerId: z.string().min(1).max(160),
    context: z.string().max(512),
    updatedAt: z.string().datetime(),
    id: z.string().min(1).max(160),
  })
  .strict();

export interface ProjectListCursor {
  updatedAt: Date;
  id: string;
}

export function encodeProjectListCursor(input: {
  scope: 'scripts' | 'boards' | 'studio' | 'gallery';
  ownerId: string;
  context: string;
  updatedAt: Date;
  id: string;
}): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      scope: input.scope,
      ownerId: input.ownerId,
      context: input.context,
      updatedAt: input.updatedAt.toISOString(),
      id: input.id,
    }),
    'utf8',
  ).toString('base64url');
}

export function decodeProjectListCursor(
  raw: string,
  expected: {
    scope: 'scripts' | 'boards' | 'studio' | 'gallery';
    ownerId: string;
    context: string;
  },
): ProjectListCursor | null {
  if (!raw || raw.length > 2_048) return null;
  try {
    const parsed = cursorSchema.safeParse(
      JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown,
    );
    if (
      !parsed.success ||
      parsed.data.scope !== expected.scope ||
      parsed.data.ownerId !== expected.ownerId ||
      parsed.data.context !== expected.context
    ) {
      return null;
    }
    const updatedAt = new Date(parsed.data.updatedAt);
    return Number.isNaN(updatedAt.getTime()) ? null : { updatedAt, id: parsed.data.id };
  } catch {
    return null;
  }
}

export function projectListContext(projectId: string | undefined): string {
  return JSON.stringify({ projectId: projectId ?? null });
}
