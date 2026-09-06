import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const FFMPEG_TIMEOUT_MS = 60_000;
const MIN_VALID_MP4_BYTES = 1024;

type FfmpegRunner = (args: string[]) => Promise<void>;

const runFfmpeg: FfmpegRunner = (args) => {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`ffmpeg faststart remux timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg faststart remux exited ${code}: ${stderr.slice(-400)}`));
    });
  });
};

function isValidFaststartMp4(bytes: Buffer): boolean {
  const moov = bytes.indexOf(Buffer.from('moov'));
  const mdat = bytes.indexOf(Buffer.from('mdat'));
  return (
    bytes.length >= MIN_VALID_MP4_BYTES &&
    bytes.subarray(4, 8).equals(Buffer.from('ftyp')) &&
    moov > 0 &&
    mdat > 0 &&
    moov < mdat
  );
}

export async function remuxVideoFaststart(
  bytes: Buffer,
  extension: string,
  runFfmpegCommand: FfmpegRunner = runFfmpeg,
): Promise<Buffer> {
  const normalizedExtension = extension.replace(/^\./, '').toLowerCase();
  const dir = await mkdtemp(join(tmpdir(), 'seed-faststart-'));
  try {
    const input = join(dir, `input.${normalizedExtension}`);
    const output = join(dir, `output.${normalizedExtension}`);
    await writeFile(input, bytes);
    await runFfmpegCommand([
      '-y',
      '-i',
      input,
      '-map',
      '0',
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      output,
    ]);
    const remuxed = await readFile(output);
    if (!isValidFaststartMp4(remuxed)) throw new Error('invalid faststart output');
    return remuxed;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
