/**
 * Upload a media file through the studio upload endpoint and return its
 * public URL. Shared by the frame slots, media pickers and the generate
 * stage dropzone. Returns null on failure — callers surface their own UI.
 */
export async function uploadMediaFile(apiUrl: string, file: File): Promise<string | null> {
  try {
    const ext = (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? '').toLowerCase();
    const res = await fetch(`${apiUrl}/v1/studio/upload?ext=${ext}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/octet-stream' },
      body: await file.arrayBuffer(),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { url?: string };
    return body.url ?? null;
  } catch {
    return null;
  }
}
