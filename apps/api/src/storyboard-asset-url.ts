const DEFAULT_MINIO_ENDPOINT = 'http://127.0.0.1:9000';

/**
 * Resolve a stored Board frame to the internal asset origin used by the PDF
 * renderer. Public storyboard links are unauthenticated, so a Board's opaque
 * resultUrl/lastFrameUrl must never become an arbitrary server-side fetch.
 *
 * Only configured own origins and the generated asset bucket are accepted.
 * Unknown external URLs, private-looking paths, and non-asset MinIO/API paths
 * become `null`; the caller renders the normal missing-frame placeholder.
 */
export function toInternalAssetUrl(
  rawUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let candidate: URL;
  try {
    candidate = new URL(rawUrl);
  } catch {
    return null;
  }
  if (candidate.protocol !== 'http:' && candidate.protocol !== 'https:') return null;
  if (candidate.username || candidate.password) return null;

  const minio = (env.MINIO_ENDPOINT ?? DEFAULT_MINIO_ENDPOINT).replace(/\/$/, '');
  const bucket = env.MINIO_BUCKET ?? 'seed-assets';
  const configured = [
    env.ASSET_PUBLIC_URL,
    env.API_PUBLIC_URL,
    env.MINIO_PUBLIC_URL,
    env.MINIO_ENDPOINT ?? DEFAULT_MINIO_ENDPOINT,
  ]
    .filter((origin): origin is string => Boolean(origin))
    .map((origin) => origin.replace(/\/$/, ''));

  for (const rawOrigin of new Set(configured)) {
    let origin: URL;
    try {
      origin = new URL(rawOrigin);
    } catch {
      continue;
    }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') continue;
    if (candidate.origin !== origin.origin) continue;

    const originPath = origin.pathname.replace(/\/$/, '');
    const candidatePath = candidate.pathname;
    const originAlreadyNamesBucket = originPath.endsWith(`/${bucket}`);
    const requiredPrefix = originAlreadyNamesBucket ? `${originPath}/` : `${originPath}/${bucket}/`;
    if (!candidatePath.startsWith(requiredPrefix)) continue;

    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(candidatePath);
    } catch {
      continue;
    }
    if (decodedPath.split('/').some((part) => part === '..')) continue;

    const suffix = candidatePath.slice(originPath.length) + candidate.search;
    const minioPath = originAlreadyNamesBucket ? `/${bucket}${suffix}` : suffix;
    return `${minio}${minioPath}`;
  }
  return null;
}
