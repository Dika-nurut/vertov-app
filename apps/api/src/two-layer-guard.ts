export interface SourceText {
  path: string;
  content: string;
}

const PLACEMENT_REFERENCE = /asset_?placements/i;

// These exact lifecycle files are sanctioned by the post-audit R1.2 ruling:
// they must inspect/pre-clean placements to make expiry and account cascades
// safe. No render or generation path is exempt. Test fixtures are listed
// explicitly rather than exempting every *.test.ts file.
const LIFECYCLE_EXCEPTIONS = [
  'apps/worker/src/anon-account-reaper.ts',
  'apps/worker/src/anon-account-reaper.integration.test.ts',
  'apps/worker/src/gallery-reaper.ts',
  'apps/worker/src/gallery-reaper.integration.test.ts',
];

function isLifecycleException(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return LIFECYCLE_EXCEPTIONS.some((allowed) => normalized.endsWith(allowed));
}

/**
 * Build-time tripwire for direct organization-layer reads. Transitive access
 * through an imported helper is intentionally not detected; this guard is a
 * tripwire, not a proof.
 */
export function assertNoPlacementReads(files: SourceText[]): void {
  const violations = files.filter(
    (file) => PLACEMENT_REFERENCE.test(file.content) && !isLifecycleException(file.path),
  );
  if (violations.length > 0) {
    throw new Error(
      `two-layer guard: placement table referenced by ${violations.map((file) => file.path).join(', ')}`,
    );
  }
}
