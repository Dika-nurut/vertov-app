import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { corpusPath } from './test-support/corpus';
import { remuxVideoFaststart } from './video-faststart';

function streamInventory(path: string): string[] {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', path],
    { encoding: 'utf8' },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim().split('\n').sort();
}

describe('provider video faststart remux', () => {
  it('stream-copies a real slowstart MP4 so moov precedes mdat', async () => {
    const sourcePath = corpusPath('bars-720p');
    const source = await readFile(sourcePath);
    expect(source.indexOf(Buffer.from('moov'))).toBeGreaterThan(
      source.indexOf(Buffer.from('mdat')),
    );

    const remuxed = await remuxVideoFaststart(source, 'mp4');

    const dir = await mkdtemp(join(tmpdir(), 'seed-faststart-test-'));
    try {
      const outputPath = join(dir, 'output.mp4');
      await writeFile(outputPath, remuxed);
      expect(remuxed.indexOf(Buffer.from('moov'))).toBeGreaterThan(0);
      expect(remuxed.indexOf(Buffer.from('mdat'))).toBeGreaterThan(0);
      expect(remuxed.indexOf(Buffer.from('moov'))).toBeLessThan(
        remuxed.indexOf(Buffer.from('mdat')),
      );
      expect(streamInventory(outputPath)).toEqual(streamInventory(sourcePath));
      expect(streamInventory(outputPath)).toEqual(['audio', 'video']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects a zero-exit remux that produced an invalid MP4', async () => {
    const source = await readFile(corpusPath('bars-720p'));

    await expect(
      remuxVideoFaststart(source, 'mp4', async (args) => {
        const mapIndex = args.indexOf('-map');
        expect(args[mapIndex + 1]).toBe('0');
        await writeFile(args.at(-1)!, Buffer.from('truncated'));
      }),
    ).rejects.toThrow('invalid faststart output');
  });
});
