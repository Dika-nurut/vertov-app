/**
 * Decide whether the test-only `/v1/dev/*` helper routes should be mounted.
 *
 * Development keeps the helpers available for the local browser floor. A
 * production process must opt in explicitly for a bounded audit window and
 * must also provide the header secret. Merely leaving `DEV_ACCESS_SECRET` in
 * a long-lived production environment is not enough to expose magic-link
 * capture, god-mode, or credit mutation routes.
 */
export function resolveDevHelpersEnabled(input: {
  nodeEnv?: string | undefined;
  devAccessSecret?: string | undefined;
  allowProdDevHelpers?: string | undefined;
}): boolean {
  if (input.nodeEnv !== 'production') return true;
  return input.allowProdDevHelpers === '1' && Boolean(input.devAccessSecret?.trim());
}
