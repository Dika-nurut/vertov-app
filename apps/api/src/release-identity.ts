/**
 * Immutable release identity baked into the API image by the deploy workflow.
 * Local/dev images may omit it; health then reports null rather than a fake
 * version or a mutable runtime value.
 */
export function releaseCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.SEED_COMMIT_SHA?.trim();
  return value ? value : null;
}
