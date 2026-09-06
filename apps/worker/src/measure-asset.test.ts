import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { measureAssetFrame } from './measure-asset';
import { CORPUS, corpusPath, corpusVideos } from './test-support/corpus';

/**
 * The lifecycle specs inject `measureFrame`, so they prove the WIRING and never touch
 * ffprobe. This suite is the other half: the default prober against real bytes with
 * known dimensions, and against the inputs that must fail open rather than lie.
 *
 * Fail-open is the property under test, not an implementation detail. Every `null` here
 * becomes `unknown` at the call site, and `unknown` never refunds. A prober that
 * answered "small" on a file it could not read would hand money back on every job.
 */
describe('measureAssetFrame: real bytes', () => {
  it('reads a real video clip at its manifest dimensions', async () => {
    const clip = corpusVideos()[0]!;
    const measured = await measureAssetFrame(readFileSync(corpusPath(clip.id)), 'mp4');
    expect(measured).toEqual({ width: clip.width, height: clip.height });
  });

  it('reads a real image at its manifest dimensions', async () => {
    const image = CORPUS.find((clip) => clip.kind === 'image');
    if (!image) return; // the corpus is video-only on some checkouts
    const measured = await measureAssetFrame(readFileSync(corpusPath(image.id)), 'png');
    expect(measured).toEqual({ width: image.width, height: image.height });
  });
});

describe('measureAssetFrame: everything that must fail open', () => {
  it('returns null for bytes ffprobe cannot parse', async () => {
    expect(await measureAssetFrame(Buffer.from('this is not a container'), 'mp4')).toBeNull();
  });

  it('returns null for an empty buffer', async () => {
    expect(await measureAssetFrame(Buffer.alloc(0), 'mp4')).toBeNull();
  });

  it('refuses to copy an asset too large to be worth the disk', async () => {
    // Over the 256 MB cap the probe is skipped outright — several concurrent long videos
    // copied to /tmp can exhaust the container's temporary storage, which would break the
    // upload and settle work that runs after this, not merely lose a measurement.
    //
    // The buffer is sparse (never written), so this allocation is virtual.
    expect(await measureAssetFrame(Buffer.alloc(257 * 1024 * 1024), 'mp4')).toBeNull();
  });

  it('sanitises the extension instead of letting it reach the filesystem', async () => {
    // The extension comes from a provider response. `../../etc/x` must not escape the
    // temp directory; the probe simply fails on the garbage bytes and answers null.
    expect(await measureAssetFrame(Buffer.from('nope'), '../../etc/passwd')).toBeNull();
  });
});
