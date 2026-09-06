import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db, projects } from '@seed/db';

type ProjectReader = Pick<typeof db, 'select'>;

export const workspaceProjectIdSchema = z.string().trim().min(1).max(160);

export interface OwnedLiveProject {
  id: string;
  title: string;
}

/**
 * Canonical project-context authorization boundary. A caller-provided project
 * id is navigation context only until this query proves that the project is
 * live and owned by the authenticated user.
 */
export async function validateOwnedLiveProject(
  reader: ProjectReader,
  projectId: string,
  userId: string,
): Promise<OwnedLiveProject | null> {
  const [project] = await reader
    .select({ id: projects.id, title: projects.title })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId), isNull(projects.deletedAt)))
    .limit(1);
  return project ?? null;
}
