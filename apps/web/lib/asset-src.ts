/**
 * Rewrite a stored asset URL to a SAME-ORIGIN path so it loads in the browser.
 *
 * Stored asset/preview URLs are minted with an absolute origin (the worker uses
 * `ASSET_PUBLIC_URL`, intentionally left as the bare MinIO host `http://<ip>` —
 * see `docs/ops/tunnel-runbook.md`). On an HTTPS page that origin is blocked two
 * ways: a plain-`http://` URL is mixed content, and a cross-origin URL also
 * defeats the `<a download>` attribute (browsers ignore it cross-origin).
 *
 * Caddy proxies `/seed-assets/*` and `/seed-preset-previews/*` → MinIO, so
 * stripping the origin to a same-origin path fixes both at once — and survives
 * tunnel rotation and the Yandex-VM cutover with zero env changes, since the
 * path is relative to whatever origin the page is served from.
 *
 * Any URL that isn't one of those two bucket paths (external, blob:, data:,
 * already-relative) is returned unchanged, so this is safe to wrap everywhere.
 */
export function assetSrc<T extends string | null | undefined>(url: T): T {
  if (!url) return url;
  return url.replace(
    /^https?:\/\/[^/]+\/(seed-preset-previews|seed-assets|seed-demo-assets)\//,
    '/$1/',
  ) as T;
}
