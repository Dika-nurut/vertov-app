import { describe, expect, it, vi } from 'vitest';
import { runDeskUploadBatch, type DeskUploadFile } from './desk-upload';

function file(name: string, bytes = new Uint8Array([1, 2, 3])): DeskUploadFile {
  return {
    name,
    size: bytes.byteLength,
    type: 'application/octet-stream',
    arrayBuffer: async () => bytes.buffer,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('runDeskUploadBatch', () => {
  it('preflights a mixed batch and uploads nothing when any file is rejected', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json({
        accepted: [{ index: 0, name: 'кадр.png' }],
        rejected: [{ index: 1, name: 'архив.zip', reason: 'Неподдерживаемый формат' }],
        canUpload: false,
      }),
    );
    const result = await runDeskUploadBatch({
      apiUrl: 'http://api.test',
      projectId: 'project-1',
      files: [file('кадр.png'), file('архив.zip')],
      destination: { kind: 'folder', folderId: 'folder-1', name: 'Референсы' },
      fetchImpl,
    });
    expect(result.receipts).toEqual([]);
    expect(result.rejected).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('creates the addressed folder with the first file, then reuses it for the batch', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          accepted: [
            { index: 0, name: 'a.png' },
            { index: 1, name: 'b.png' },
          ],
          rejected: [],
          canUpload: true,
        }),
      )
      .mockResolvedValueOnce(
        json(
          {
            assetId: 'asset-a',
            destinationId: 'folder-new',
            reused: false,
            alreadyMember: false,
            receipt: 'Материал загружен',
          },
          201,
        ),
      )
      .mockResolvedValueOnce(
        json({
          assetId: 'asset-b',
          destinationId: 'folder-new',
          reused: true,
          alreadyMember: true,
          receipt: 'Уже в этом проекте',
        }),
      );
    const progress = vi.fn();
    const result = await runDeskUploadBatch({
      apiUrl: 'http://api.test/',
      projectId: 'project-1',
      files: [file('a.png'), file('b.png')],
      destination: { kind: 'new-folder', name: 'Новая' },
      fetchImpl,
      onProgress: progress,
    });
    expect(result.destinationId).toBe('folder-new');
    expect(result.receipts.map((receipt) => receipt.reused)).toEqual([false, true]);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain(
      'newFolderName=%D0%9D%D0%BE%D0%B2%D0%B0%D1%8F',
    );
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain('folderId=folder-new');
    expect(progress).toHaveBeenLastCalledWith(2, 2);
  });
});
