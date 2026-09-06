import { describe, expect, it } from 'vitest';
import {
  boardQuoteKey,
  createBoardQuoteRegistry,
  isVideoShotResult,
  wiredImageRefs,
  wiredVideoRefUrls,
} from './board-quote';

/**
 * The one classifier every route uses to decide whether a produced result rides
 * as a motion reference: the already-done branch, the Run All output map, the
 * inline-run branch, and this module's own prediction. If any of them disagreed,
 * a result would be a video input when quoted and an image input when submitted,
 * and the charge could no longer be bound to the price the customer saw.
 */
describe('isVideoShotResult — one rule for every route', () => {
  it('trusts the recorded kind over the URL', () => {
    // The case a suffix-only classifier gets wrong: a real video served from a
    // signed / query-only URL with no recognised extension.
    expect(isVideoShotResult({ url: 'https://cdn.test/asset?id=9', resultKind: 'video' })).toBe(
      true,
    );
    expect(isVideoShotResult({ url: 'https://cdn.test/asset?id=9' })).toBe(false);
  });

  it('falls back to the URL when no kind was recorded', () => {
    expect(isVideoShotResult({ url: 'https://cdn.test/a.mp4' })).toBe(true);
    expect(isVideoShotResult({ url: 'https://cdn.test/a.webm?sig=1' })).toBe(true);
    expect(isVideoShotResult({ url: 'https://cdn.test/a.png' })).toBe(false);
    expect(isVideoShotResult({ url: 'https://cdn.test/a.png', resultKind: undefined })).toBe(false);
  });

  it('does not treat a non-video kind as video', () => {
    expect(isVideoShotResult({ url: 'https://cdn.test/a.png', resultKind: 'image' })).toBe(false);
  });
});

/**
 * `videoUrls` presence is a price selector on the API (`priceSelectorFromParams`
 * → `videoInput`). These pin the badge's view of "does this shot carry a motion
 * reference" to the view `GraphBoard.runNode` compiles the submitted request
 * with — the two disagreeing is what made the desktop board quote one price and
 * charge another.
 */
describe('wiredVideoRefUrls — what the submit will carry as motion refs', () => {
  const shot = { id: 'shot', type: 'generate', data: { mode: 'video' } };

  it('finds a wired video media node', () => {
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [shot, { id: 'clip', type: 'media', data: { mediaKind: 'video', url: 'a.mp4' } }],
      edges: [{ source: 'clip', target: 'shot', targetHandle: 'images[0]' }],
      videoReferenceMax: 3,
    });
    expect(urls).toEqual(['a.mp4']);
  });

  it('ignores an image media node — a still is not a motion reference', () => {
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [shot, { id: 'still', type: 'media', data: { mediaKind: 'image', url: 'a.png' } }],
      edges: [{ source: 'still', target: 'shot', targetHandle: 'images[0]' }],
      videoReferenceMax: 3,
    });
    expect(urls).toEqual([]);
  });

  it('ignores a reference wired into another shot', () => {
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [
        shot,
        { id: 'other', type: 'generate', data: { mode: 'video' } },
        { id: 'clip', type: 'media', data: { mediaKind: 'video', url: 'a.mp4' } },
      ],
      edges: [{ source: 'clip', target: 'other', targetHandle: 'images[0]' }],
      videoReferenceMax: 3,
    });
    expect(urls).toEqual([]);
  });

  it('ignores an edge that is not a reference slot (a wired prompt)', () => {
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [shot, { id: 'clip', type: 'media', data: { mediaKind: 'video', url: 'a.mp4' } }],
      edges: [{ source: 'clip', target: 'shot', targetHandle: 'prompt' }],
      videoReferenceMax: 3,
    });
    expect(urls).toEqual([]);
  });

  it('takes a FINISHED upstream shot that rendered a clip', () => {
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [
        shot,
        {
          id: 'up',
          type: 'generate',
          data: { mode: 'video', status: 'done', resultUrl: 'up.mp4', resultKind: 'video' },
        },
      ],
      edges: [{ source: 'up', target: 'shot', targetHandle: 'images[0]' }],
      videoReferenceMax: 3,
    });
    expect(urls).toEqual(['up.mp4']);
  });

  it('takes a finished upstream whose video URL has no recognised extension', () => {
    // Suffix-only classification would call this an image here and a video in
    // `resolveRefs`'s done branch — the disagreement that unbinds the submit.
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [
        shot,
        {
          id: 'up',
          type: 'generate',
          data: { status: 'done', resultUrl: 'https://cdn.test/asset?id=9', resultKind: 'video' },
        },
      ],
      edges: [{ source: 'up', target: 'shot', targetHandle: 'images[0]' }],
      videoReferenceMax: 3,
    });
    expect(urls).toEqual(['https://cdn.test/asset?id=9']);
  });

  it('classifies a finished upstream by its URL when resultKind is missing', () => {
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [
        shot,
        { id: 'up', type: 'generate', data: { status: 'done', resultUrl: 'up.webm?sig=1' } },
      ],
      edges: [{ source: 'up', target: 'shot', targetHandle: 'images[0]' }],
      videoReferenceMax: 3,
    });
    expect(urls).toEqual(['up.webm?sig=1']);
  });

  // A shot that is merely RUNNING when we quote is routinely `done` by the time
  // `resolveRefs` walks it, and a finished video shot rides as a motion ref. So
  // the price of a shot downstream of a rendering clip must already include the
  // video input — quoting it as "no video" is what unbound every such submit.
  const pendingUpstream = (data: Record<string, unknown>) =>
    wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [shot, { id: 'up', type: 'generate', data }],
      edges: [{ source: 'up', target: 'shot', targetHandle: 'images[0]' }],
      videoReferenceMax: 3,
    });

  it('counts an upstream video shot that has not finished yet', () => {
    expect(pendingUpstream({ mode: 'video', status: 'running', jobId: 'j1' })).toEqual([
      'pending://up',
    ]);
    expect(pendingUpstream({ mode: 'video', status: 'idle' })).toEqual(['pending://up']);
    expect(pendingUpstream({ mode: 'video', status: 'failed' })).toEqual(['pending://up']);
  });

  it('does NOT count an unfinished upstream that renders a still', () => {
    expect(pendingUpstream({ mode: 'image', status: 'idle' })).toEqual([]);
    expect(pendingUpstream({ mode: 'image', status: 'running', jobId: 'j1' })).toEqual([]);
  });

  // Re-running a finished shot patches status back to 'running' WITHOUT
  // clearing the previous result, so the stale `resultUrl` must not be quoted
  // as the reference — the shot is going to render a new one.
  it('uses the sentinel, not the stale result, for a shot that is running again', () => {
    expect(
      pendingUpstream({
        mode: 'video',
        status: 'running',
        resultUrl: 'old.mp4',
        resultKind: 'video',
      }),
    ).toEqual(['pending://up']);
  });

  it('keys the sentinel per node, so two pending upstreams are two references', () => {
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [
        shot,
        { id: 'a', type: 'generate', data: { mode: 'video', status: 'idle' } },
        { id: 'b', type: 'generate', data: { mode: 'video', status: 'idle' } },
      ],
      edges: [
        { source: 'a', target: 'shot', targetHandle: 'images[0]' },
        { source: 'b', target: 'shot', targetHandle: 'images[1]' },
      ],
      videoReferenceMax: 3,
    });
    expect(urls).toEqual(['pending://a', 'pending://b']);
  });

  it('takes a Локация ambience clip off a cast node', () => {
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [
        shot,
        {
          id: 'loc',
          type: 'cast',
          data: { castKind: 'location', imageUrls: ['l.png'], videoUrl: 'l.mp4' },
        },
      ],
      edges: [{ source: 'loc', target: 'shot', targetHandle: 'images[0]' }],
      videoReferenceMax: 3,
    });
    expect(urls).toEqual(['l.mp4']);
  });

  it('drops a gallery media node whose asset has not resolved', () => {
    const nodes = [
      shot,
      { id: 'clip', type: 'media', data: { mediaKind: 'video', url: '', assetId: 'asset-1' } },
    ];
    const edges = [{ source: 'clip', target: 'shot', targetHandle: 'images[0]' }];
    expect(wiredVideoRefUrls({ nodeId: 'shot', nodes, edges, videoReferenceMax: 3 })).toEqual([]);
    expect(
      wiredVideoRefUrls({
        nodeId: 'shot',
        nodes,
        edges,
        videoReferenceMax: 3,
        resolveAssetUrl: (id) => (id === 'asset-1' ? 'signed.mp4' : undefined),
      }),
    ).toEqual(['signed.mp4']);
  });

  it('gives a model that accepts no motion refs none, however many are wired', () => {
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [shot, { id: 'clip', type: 'media', data: { mediaKind: 'video', url: 'a.mp4' } }],
      edges: [{ source: 'clip', target: 'shot', targetHandle: 'images[0]' }],
      videoReferenceMax: 0,
    });
    expect(urls).toEqual([]);
  });

  it('de-duplicates and caps at the model limit, in slot order', () => {
    const urls = wiredVideoRefUrls({
      nodeId: 'shot',
      nodes: [
        shot,
        { id: 'c1', type: 'media', data: { mediaKind: 'video', url: 'a.mp4' } },
        { id: 'c2', type: 'media', data: { mediaKind: 'video', url: 'b.mp4' } },
        { id: 'c3', type: 'media', data: { mediaKind: 'video', url: 'a.mp4' } },
        { id: 'c4', type: 'media', data: { mediaKind: 'video', url: 'c.mp4' } },
      ],
      edges: [
        { source: 'c4', target: 'shot', targetHandle: 'images[3]' },
        { source: 'c2', target: 'shot', targetHandle: 'images[1]' },
        { source: 'c3', target: 'shot', targetHandle: 'images[2]' },
        { source: 'c1', target: 'shot', targetHandle: 'images[0]' },
      ],
      videoReferenceMax: 2,
    });
    expect(urls).toEqual(['a.mp4', 'b.mp4']);
  });
});

describe('wiredImageRefs — what the submit will carry as stills and frames', () => {
  it('keeps a wired frame in the typed frameImages representation', () => {
    const refs = wiredImageRefs({
      nodeId: 'shot',
      nodes: [
        { id: 'shot', type: 'generate', data: { mode: 'video' } },
        { id: 'still', type: 'media', data: { mediaKind: 'image', url: 'first.png' } },
      ],
      edges: [{ source: 'still', target: 'shot', targetHandle: 'images[0]' }],
      imageInput: { role: 'frame', max: 2, frameRoles: ['first', 'last'] },
      imageReferenceMax: 0,
    });

    expect(refs).toEqual({
      imageUrls: [],
      frameImages: [{ role: 'first', url: 'first.png' }],
      pendingReferenceCount: 0,
      pendingFrameCount: 0,
    });
  });

  it('counts an unrendered upstream in the CHANNEL it will arrive in', () => {
    // A still that has not rendered yet contributes no URL, only a count — and which
    // count matters. Wired into a frame slot it becomes `frameImages` at submit, so
    // counting it as a pending reference described a request the runner never sends.
    const framed = wiredImageRefs({
      nodeId: 'shot',
      nodes: [
        { id: 'shot', type: 'generate', data: { mode: 'video' } },
        { id: 'upstream', type: 'generate', data: { mode: 'image', status: 'running' } },
      ],
      edges: [{ source: 'upstream', target: 'shot', targetHandle: 'images[0]' }],
      imageInput: { role: 'frame', max: 2, frameRoles: ['first', 'last'] },
      imageReferenceMax: 0,
    });
    expect(framed).toEqual({
      imageUrls: [],
      frameImages: [],
      pendingReferenceCount: 0,
      pendingFrameCount: 1,
    });

    const referenced = wiredImageRefs({
      nodeId: 'shot',
      nodes: [
        { id: 'shot', type: 'generate', data: { mode: 'image' } },
        { id: 'upstream', type: 'generate', data: { mode: 'image', status: 'running' } },
      ],
      edges: [{ source: 'upstream', target: 'shot', targetHandle: 'referenceImages[0]' }],
      imageInput: { role: 'reference', max: 9, frameRoles: [] },
      imageReferenceMax: 9,
    });
    expect(referenced).toEqual({
      imageUrls: [],
      frameImages: [],
      pendingReferenceCount: 1,
      pendingFrameCount: 0,
    });
  });

  it('keeps wired reference images in imageUrls for Run All and the badge', () => {
    const refs = wiredImageRefs({
      nodeId: 'shot',
      nodes: [
        { id: 'shot', type: 'generate', data: { mode: 'image' } },
        { id: 'still', type: 'media', data: { mediaKind: 'image', url: 'reference.png' } },
      ],
      edges: [{ source: 'still', target: 'shot', targetHandle: 'referenceImages[0]' }],
      imageInput: { role: 'reference', max: 9, frameRoles: [] },
      imageReferenceMax: 9,
    });

    expect(refs).toEqual({
      imageUrls: ['reference.png'],
      frameImages: [],
      pendingReferenceCount: 0,
      pendingFrameCount: 0,
    });
  });

  it('counts an upstream still that has not rendered instead of inventing its URL', () => {
    // The Run All case: B takes A's output. A has not run when B is quoted, so
    // there is no URL to send — but the reference WILL exist, and a band price
    // counts it. Quoting one reference short is what `expectedCost` turns into a
    // 409 that a retry reproduces, because the retry re-takes the same snapshot.
    const refs = wiredImageRefs({
      nodeId: 'shot',
      nodes: [
        { id: 'shot', type: 'generate', data: { mode: 'image' } },
        { id: 'settled', type: 'media', data: { mediaKind: 'image', url: 'settled.png' } },
        { id: 'upstream', type: 'generate', data: { mode: 'image', status: 'idle' } },
      ],
      edges: [
        { source: 'settled', target: 'shot', targetHandle: 'referenceImages[0]' },
        { source: 'upstream', target: 'shot', targetHandle: 'referenceImages[1]' },
      ],
      imageInput: { role: 'reference', max: 9, frameRoles: [] },
      imageReferenceMax: 9,
    });

    expect(refs.imageUrls).toEqual(['settled.png']);
    expect(refs.pendingReferenceCount).toBe(1);
  });
});

/**
 * The key is the whole safety argument: `expectedCost` may be bound only when
 * the stored number provably prices the request being submitted. So it must
 * change on every dimension the server prices by, and on nothing else — a key
 * that moves for a non-price field would silently unbind every submit.
 */
describe('boardQuoteKey — the price-relevant identity of a request', () => {
  const video = (params: Record<string, unknown>) =>
    boardQuoteKey({
      modelId: 'seedance-2-0-fast',
      mode: 'video',
      params: {
        duration_seconds: 5,
        resolution: '720p',
        aspect_ratio: '16:9',
        return_last_frame: true,
        ...params,
      },
    });

  it('is stable for the same request', () => {
    expect(video({})).toBe(video({}));
  });

  it('tracks the audio price state while ignoring prompt grammar', () => {
    const kling = (params: Record<string, unknown>) =>
      boardQuoteKey({
        modelId: 'kling-v3-0-std',
        mode: 'video',
        params: {
          duration_seconds: 5,
          resolution: '720p',
          aspect_ratio: '16:9',
          ...params,
        },
      });

    expect(video({ shotGrammar: { size: 'CU', move: 'push-in' } })).toBe(video({}));
    // The server/adapter default is audio=true when the field is absent.
    expect(kling({ generate_audio: true })).toBe(kling({}));
    // Kling's 720p ladder has separate 270-credit (audio) and 180-credit
    // (quiet) rows, so a quote must never cross this boundary.
    expect(kling({ generate_audio: false })).not.toBe(kling({}));
  });

  it('changes on the reference COUNT and on frame presence — both are priced', () => {
    // Rev. 10 made both a price dimension: a 2–8-reference Flux job and an
    // image-to-video shot are their own configurations. This test used to assert
    // the opposite, on the then-true ground that references changed no price.
    const bare = video({});
    expect(video({ imageUrls: ['http://example.test/a.png'] })).not.toBe(bare);
    expect(
      video({ imageUrls: ['http://example.test/a.png', 'http://example.test/b.png'] }),
    ).not.toBe(video({ imageUrls: ['http://example.test/a.png'] }));
    // COUNT, not identity — the runner sends different URLs than the badge saw.
    expect(video({ imageUrls: ['http://example.test/z.png'] })).toBe(
      video({ imageUrls: ['http://example.test/a.png'] }),
    );
    expect(video({ frameImages: [{ role: 'first', url: 'http://example.test/f.png' }] })).not.toBe(
      bare,
    );
  });

  it('a pending upstream counts exactly like the reference it will become', () => {
    // The reason the count can live in this key at all: the badge counts an
    // unrendered upstream, the runner sends its resolved URL, and the two
    // therefore produce the SAME key rather than never matching.
    expect(
      boardQuoteKey({
        modelId: 'seedance-2-0-fast',
        mode: 'video',
        params: { resolution: '720p', duration_seconds: 5, aspect_ratio: '16:9' },
        pendingReferenceCount: 1,
      }),
    ).toBe(video({ imageUrls: ['http://example.test/resolved.png'] }));
  });

  it('a pending upstream bound for a FRAME counts as the frame it will become', () => {
    // The half the test above did not cover, and the half that broke Run All: on a
    // frame-role model the pending still becomes `frameImages`, not `imageUrls`.
    // Counted as a pending reference it read as «1 reference, 0 frames» before the
    // run and «0 references, 1 frame» after — two different keys for one request,
    // so the runner refused the price it had just been quoted.
    expect(
      boardQuoteKey({
        modelId: 'wan-2-7',
        mode: 'video',
        params: { resolution: '720p', duration_seconds: 5, aspect_ratio: '16:9' },
        pendingFrameCount: 1,
      }),
    ).toBe(
      boardQuoteKey({
        modelId: 'wan-2-7',
        mode: 'video',
        params: {
          resolution: '720p',
          duration_seconds: 5,
          aspect_ratio: '16:9',
          frameImages: [{ role: 'first', url: 'http://example.test/resolved.png' }],
        },
      }),
    );
    // And it is NOT the same request as one carrying a loose reference: on a model
    // that prices a reference band the two would be different money.
    expect(
      boardQuoteKey({
        modelId: 'wan-2-7',
        mode: 'video',
        params: { resolution: '720p', duration_seconds: 5, aspect_ratio: '16:9' },
        pendingFrameCount: 1,
      }),
    ).not.toBe(
      boardQuoteKey({
        modelId: 'wan-2-7',
        mode: 'video',
        params: { resolution: '720p', duration_seconds: 5, aspect_ratio: '16:9' },
        pendingReferenceCount: 1,
      }),
    );
  });

  it('changes when a motion reference appears — videoInput is a price selector', () => {
    const without = video({});
    const with1 = video({ videoUrls: ['http://example.test/motion.mp4'] });
    expect(with1).not.toBe(without);
    // …but only PRESENCE matters: which clip, and how many, do not.
    expect(video({ videoUrls: ['http://example.test/other.mov'] })).toBe(with1);
    expect(video({ videoUrls: ['http://example.test/a.mp4', 'http://example.test/b.mp4'] })).toBe(
      with1,
    );
    // an empty array is not an input
    expect(video({ videoUrls: [] })).toBe(without);
  });

  it('changes on resolution, duration and model', () => {
    expect(video({ resolution: '480p' })).not.toBe(video({}));
    expect(video({ duration_seconds: 6 })).not.toBe(video({}));
    expect(
      boardQuoteKey({ modelId: 'veo-3-1', mode: 'video', params: { duration_seconds: 5 } }),
    ).not.toBe(
      boardQuoteKey({ modelId: 'wan-2-7', mode: 'video', params: { duration_seconds: 5 } }),
    );
  });

  // Not a price SELECTOR, but `normalizeVideoParams` rejects an unaccepted
  // aspect on the contract billing path, turning a resolvable price into a
  // refusal — so it can change the answer.
  it('changes on aspect ratio', () => {
    expect(video({ aspect_ratio: '9:16' })).not.toBe(video({}));
  });

  it('counts image takes, because `n` is the billed unit', () => {
    const image = (n: number) =>
      boardQuoteKey({ modelId: 'seedream-4-5', mode: 'image', params: { n, resolution: '2K' } });
    expect(image(1)).not.toBe(image(4));
  });

  // Video providers render `resolution` and IGNORE `quality`, so a video
  // `quality` must never alias a resolution — else a crafted {quality:'480p'}
  // would key as 480p while a 720p render is billed.
  it('accepts the legacy `quality` alias for images only', () => {
    const asImage = (params: Record<string, unknown>) =>
      boardQuoteKey({ modelId: 'gpt-image-2', mode: 'image', params: { n: 1, ...params } });
    expect(asImage({ quality: '2K' })).toBe(asImage({ resolution: '2K' }));
    // `resolution` still wins when both are present, matching firstString order
    expect(asImage({ resolution: '2K', quality: '4K' })).toBe(asImage({ resolution: '2K' }));
  });

  it('never lets a video `quality` stand in for a resolution', () => {
    // The shape that matters is quality WITHOUT resolution: if the alias were
    // honoured for video, a crafted {quality:'480p'} would key as 480p while a
    // 720p render is billed. Both of these carry no resolution at all, so they
    // must key identically — the quality is simply not read.
    const asVideo = (params: Record<string, unknown>) =>
      boardQuoteKey({
        modelId: 'seedance-2-0-fast',
        mode: 'video',
        params: { duration_seconds: 5, ...params },
      });
    expect(asVideo({ quality: '480p' })).toBe(asVideo({}));
    expect(asVideo({ quality: '480p' })).toBe(asVideo({ quality: '1080p' }));
  });

  it('coerces a numeric field the way the server does', () => {
    // `Number(...)`, not `String(...)`: the server reads these through Number,
    // so '5.0', '5' and 5 are one and the same billed duration.
    expect(video({ duration_seconds: '5' })).toBe(video({ duration_seconds: 5 }));
    expect(video({ duration_seconds: '5.0' })).toBe(video({ duration_seconds: 5 }));
    expect(boardQuoteKey({ modelId: 'x', mode: 'image', params: { n: '4.0' } })).toBe(
      boardQuoteKey({ modelId: 'x', mode: 'image', params: { n: 4 } }),
    );
  });

  // The key decides whether one request's price may be charged for another, so
  // no field value may be able to forge another field's boundary. Model ids and
  // capability values are database data and the request schema permits
  // arbitrary param strings, so this is reachable, not theoretical.
  it('cannot be collided by a value that looks like the delimiters', () => {
    const a = boardQuoteKey({
      modelId: 'm',
      mode: 'video',
      params: { resolution: 'x|ar=y', aspect_ratio: 'z' },
    });
    const b = boardQuoteKey({
      modelId: 'm',
      mode: 'video',
      params: { resolution: 'x', aspect_ratio: 'y|ar=z' },
    });
    expect(a).not.toBe(b);
  });

  it('cannot be collided by shifting a character between adjacent fields', () => {
    // The general property, independent of which delimiter is chosen: moving a
    // character from one field to the next must change the key. A bare
    // concatenation fails this; so does any scheme where a field can end early.
    const key = (resolution: string, aspect_ratio: string) =>
      boardQuoteKey({ modelId: 'm', mode: 'image', params: { resolution, aspect_ratio } });
    expect(key('ab', 'c')).not.toBe(key('a', 'bc'));
    expect(key('', 'abc')).not.toBe(key('abc', ''));
  });

  it('distinguishes an absent field from one set to an empty-ish value', () => {
    expect(boardQuoteKey({ modelId: 'm', mode: 'image', params: {} })).not.toBe(
      boardQuoteKey({ modelId: 'm', mode: 'image', params: { n: 0 } }),
    );
  });

  it('separates the two modes even with identical params', () => {
    const params = { resolution: '2K' };
    expect(boardQuoteKey({ modelId: 'x', mode: 'video', params })).not.toBe(
      boardQuoteKey({ modelId: 'x', mode: 'image', params }),
    );
  });
});

describe('board quote registry — a number is readable only for the request it prices', () => {
  it('reads back a quote under its own key', () => {
    const registry = createBoardQuoteRegistry();
    registry.publish('shot', 'k1', 42);
    expect(registry.read('shot', 'k1')).toBe(42);
  });

  it('reads null for a DIFFERENT key — the badge moved on, so the number is not this price', () => {
    const registry = createBoardQuoteRegistry();
    registry.publish('shot', 'k1', 42);
    expect(registry.read('shot', 'k2')).toBeNull();
  });

  it('reads null for a node that never published', () => {
    expect(createBoardQuoteRegistry().read('shot', 'k1')).toBeNull();
  });

  it('keeps quotes separate per node', () => {
    const registry = createBoardQuoteRegistry();
    registry.publish('a', 'k', 10);
    registry.publish('b', 'k', 20);
    expect(registry.read('a', 'k')).toBe(10);
    expect(registry.read('b', 'k')).toBe(20);
  });

  it('a re-quote of the same key replaces the number', () => {
    const registry = createBoardQuoteRegistry();
    registry.publish('shot', 'k1', 42);
    registry.publish('shot', 'k1', 51);
    expect(registry.read('shot', 'k1')).toBe(51);
  });

  // The «Снять всё» sheet and the node badge both write here. The sheet quotes
  // shots whose nodes React Flow has unmounted, so the last writer must win
  // rather than either erasing the other.
  it('lets a second writer replace an entry, and never erases on its own', () => {
    const registry = createBoardQuoteRegistry();
    registry.publish('shot', 'k1', 42); // badge
    registry.publish('shot', 'k2', 99); // Run All sheet, different config
    expect(registry.read('shot', 'k2')).toBe(99);
    expect(registry.read('shot', 'k1')).toBeNull();
  });

  it('refuses a non-finite cost — NaN must never reach expectedCost', () => {
    const registry = createBoardQuoteRegistry();
    registry.publish('shot', 'k1', Number.NaN);
    expect(registry.read('shot', 'k1')).toBeNull();
  });
});

describe('the pending count matches how the submit will actually shape the request', () => {
  const twoSlotsFromOneNode = (
    imageInput: { role: 'frame' | 'reference'; max: number; frameRoles: ('first' | 'last')[] },
    handles: [string, string],
  ) =>
    wiredImageRefs({
      nodeId: 'shot',
      nodes: [
        { id: 'shot', type: 'generate', data: { mode: 'image' } },
        { id: 'upstream', type: 'generate', data: { mode: 'image', status: 'running' } },
      ],
      edges: [
        { source: 'upstream', target: 'shot', targetHandle: handles[0] },
        { source: 'upstream', target: 'shot', targetHandle: handles[1] },
      ],
      imageInput,
      imageReferenceMax: 9,
    });

  it('counts one unrendered node in two REFERENCE slots once', () => {
    // Both edges resolve to the same URL, and `assembleShotRefs` de-duplicates it, so
    // the submit carries one reference. Counting the edges quoted two — a different
    // key from the one the runner then computes, and on Flux a different price.
    expect(
      twoSlotsFromOneNode({ role: 'reference', max: 9, frameRoles: [] }, [
        'referenceImages[0]',
        'referenceImages[1]',
      ]).pendingReferenceCount,
    ).toBe(1);
  });

  it('counts one unrendered node in two FRAME slots twice', () => {
    // The opposite, and for the opposite reason: a still wired to both `first` and
    // `last` compiles into TWO frameImages entries — same URL, different roles — and
    // nothing de-duplicates them. The count has to mirror the request, not a rule.
    expect(
      twoSlotsFromOneNode({ role: 'frame', max: 2, frameRoles: ['first', 'last'] }, [
        'images[0]',
        'images[1]',
      ]).pendingFrameCount,
    ).toBe(2);
  });
});
