export interface DeskUploadFile {
  name: string;
  size: number;
  type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type DeskUploadDestination =
  | { kind: 'unfiled' }
  | { kind: 'folder'; folderId: string; name: string }
  | { kind: 'new-folder'; name: string };

export interface PreflightRejection {
  index: number;
  name: string;
  reason: string;
}

export interface UploadedAssetReceipt {
  assetId: string;
  destinationId: string | null;
  reused: boolean;
  alreadyMember: boolean;
  receipt: string;
}

export interface UploadBatchResult {
  accepted: number;
  rejected: PreflightRejection[];
  receipts: UploadedAssetReceipt[];
  destinationId: string | null;
}

interface RunUploadBatchOptions {
  apiUrl: string;
  projectId: string;
  files: DeskUploadFile[];
  destination: DeskUploadDestination;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

function jsonHeaders() {
  return { 'content-type': 'application/json' };
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as T | null;
  if (!response.ok || body === null) {
    const error = new Error(`upload_http_${response.status}`) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body;
}

/**
 * Shared addressed-upload command used by OS drops and the no-drag file picker.
 * It preflights the whole batch before sending a single byte.
 */
export async function runDeskUploadBatch({
  apiUrl,
  projectId,
  files,
  destination,
  fetchImpl = fetch,
  signal,
  onProgress,
}: RunUploadBatchOptions): Promise<UploadBatchResult> {
  const base = apiUrl.replace(/\/$/, '');
  const encodedProject = encodeURIComponent(projectId);
  const preflight = await responseJson<{
    accepted: Array<{ index: number; name: string }>;
    rejected: PreflightRejection[];
    canUpload: boolean;
  }>(
    await fetchImpl(`${base}/v1/projects/${encodedProject}/assets/preflight`, {
      method: 'POST',
      credentials: 'include',
      headers: jsonHeaders(),
      body: JSON.stringify({
        files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
      }),
      signal: signal ?? null,
    }),
  );
  if (!preflight.canUpload) {
    return {
      accepted: preflight.accepted.length,
      rejected: preflight.rejected,
      receipts: [],
      destinationId: null,
    };
  }

  let destinationId = destination.kind === 'folder' ? destination.folderId : null;
  const receipts: UploadedAssetReceipt[] = [];
  for (let index = 0; index < files.length; index += 1) {
    signal?.throwIfAborted();
    const file = files[index]!;
    const query = new URLSearchParams({ name: file.name });
    if (destinationId) query.set('folderId', destinationId);
    else if (destination.kind === 'new-folder' && index === 0)
      query.set('newFolderName', destination.name);
    const receipt = await responseJson<UploadedAssetReceipt>(
      await fetchImpl(`${base}/v1/projects/${encodedProject}/assets?${query.toString()}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
        signal: signal ?? null,
      }),
    );
    destinationId = receipt.destinationId ?? destinationId;
    receipts.push(receipt);
    onProgress?.(index + 1, files.length);
  }
  return {
    accepted: preflight.accepted.length,
    rejected: [],
    receipts,
    destinationId,
  };
}
