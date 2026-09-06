import { describe, expect, it } from 'vitest';
import type { StudioClip, StudioRenderSpec } from '@seed/db';
import {
  buildAssemblyGraph,
  buildAtempoChain,
  buildKeyframeChain,
  buildColorChain,
  buildDuckVolumeExpr,
  buildMaskBlendChain,
  buildNormalizeArgs,
  buildSpeedRamp,
  clampTransform,
  freeformMaskExpr,
  kfExpr,
  clampTransitionSec,
  clipOutputDuration,
  drawtextFilter,
  escapeDrawtext,
  fitRenderDimensions,
} from './studio-graph';

const FONTS = {
  sans: '/f/sans.ttf',
  serif: '/f/serif.ttf',
  display: '/f/display.ttf',
  mono: '/f/mono.ttf',
};

function spec(partial: Partial<StudioRenderSpec> = {}): StudioRenderSpec {
  return { clips: [], width: 1280, height: 720, fps: 30, ...partial };
}

describe('buildAssemblyGraph', () => {
  it('single clip routes video through a real graph label (mappable)', () => {
    const g = buildAssemblyGraph({
      durations: [5],
      clips: [{ url: 'a.mp4' }],
      spec: spec({ clips: [{ url: 'a.mp4' }] }),
      fonts: FONTS,
    });
    // -map '[0:v]' would be parsed as a (nonexistent) graph label — the
    // builder must emit a no-op filter so the mapped label always exists.
    expect(g.videoLabel).toBe('[vone]');
    expect(g.filterComplex).toBe('[0:v]null[vone];[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[aout]');
    expect(g.totalDuration).toBe(5);
  });

  it('all-cut timelines use the concat filter', () => {
    const clips = [{ url: 'a.mp4' }, { url: 'b.mp4' }, { url: 'c.mp4' }];
    const g = buildAssemblyGraph({
      durations: [4, 5, 6],
      clips,
      spec: spec({ clips }),
      fonts: FONTS,
    });
    expect(g.filterComplex).toContain('concat=n=3:v=1:a=1[vcat][acat]');
    expect(g.totalDuration).toBe(15);
  });

  it('crossfade chain computes accumulated offsets and shortens the total', () => {
    const clips = [
      { url: 'a.mp4', transition: 'crossfade' as const, transitionSec: 1 },
      { url: 'b.mp4', transition: 'dip' as const, transitionSec: 0.5 },
      { url: 'c.mp4' },
    ];
    const g = buildAssemblyGraph({
      durations: [4, 6, 5],
      clips,
      spec: spec({ clips }),
      fonts: FONTS,
    });
    // first xfade: offset = 4 - 1 = 3; acc = 4 - 1 + 6 = 9
    expect(g.filterComplex).toContain('xfade=transition=fade:duration=1:offset=3[vx0]');
    // second: dip → fadeblack at offset 9 - 0.5 = 8.5; total = 9 - 0.5 + 5 = 13.5
    expect(g.filterComplex).toContain('xfade=transition=fadeblack:duration=0.5:offset=8.5[vx1]');
    expect(g.filterComplex).toContain('acrossfade=d=1[ax0]');
    expect(g.totalDuration).toBe(13.5);
  });

  it('flash maps to the fadewhite xfade', () => {
    const clips = [
      { url: 'a.mp4', transition: 'flash' as const, transitionSec: 0.5 },
      { url: 'b.mp4' },
    ];
    const g = buildAssemblyGraph({ durations: [4, 5], clips, spec: spec({ clips }), fonts: FONTS });
    expect(g.filterComplex).toContain('xfade=transition=fadewhite:duration=0.5:offset=3.5');
  });

  it.each([
    ['slideleft', 'slideleft'],
    ['slideright', 'slideright'],
    ['slideup', 'slideup'],
    ['slidedown', 'slidedown'],
    ['wipeleft', 'wipeleft'],
    ['wiperight', 'wiperight'],
    ['wipeup', 'wipeup'],
    ['wipedown', 'wipedown'],
    ['circleopen', 'circleopen'],
    ['circleclose', 'circleclose'],
    ['zoomin', 'zoomin'],
  ] as const)('geometric transition %s maps to the %s xfade mode', (id, mode) => {
    const clips = [{ url: 'a.mp4', transition: id, transitionSec: 0.5 }, { url: 'b.mp4' }];
    const g = buildAssemblyGraph({ durations: [4, 5], clips, spec: spec({ clips }), fonts: FONTS });
    // offset = 4 - 0.5 = 3.5; the audio still rides the acrossfade.
    expect(g.filterComplex).toContain(`xfade=transition=${mode}:duration=0.5:offset=3.5[vx0]`);
    expect(g.filterComplex).toContain('acrossfade=d=0.5[ax0]');
    expect(g.totalDuration).toBe(8.5);
  });

  it('clamps the transition to half of the shorter adjacent clip', () => {
    const clips = [
      { url: 'a.mp4', transition: 'crossfade' as const, transitionSec: 1.5 },
      { url: 'b.mp4' },
    ];
    const g = buildAssemblyGraph({ durations: [1, 8], clips, spec: spec({ clips }), fonts: FONTS });
    expect(g.filterComplex).toContain('duration=0.5:offset=0.5');
  });

  it('mixed cut + crossfade keeps the chain uniform via pairwise concat', () => {
    const clips = [
      { url: 'a.mp4' }, // cut into b
      { url: 'b.mp4', transition: 'crossfade' as const, transitionSec: 0.4 },
      { url: 'c.mp4' },
    ];
    const g = buildAssemblyGraph({
      durations: [3, 3, 3],
      clips,
      spec: spec({ clips }),
      fonts: FONTS,
    });
    expect(g.filterComplex).toContain('concat=n=2:v=1:a=1[vx0][ax0]');
    // concat output (1/1e6 tb) + raw input (1/15360 tb) must be settb'd or
    // xfade refuses to configure — regression guard for the mixed chain.
    expect(g.filterComplex).toContain('[vx0]settb=AVTB[vtba1]');
    expect(g.filterComplex).toContain('[2:v]settb=AVTB[vtbb1]');
    // offset = (3+3) - 0.4 = 5.6
    expect(g.filterComplex).toContain('xfade=transition=fade:duration=0.4:offset=5.6[vx1]');
    expect(g.totalDuration).toBeCloseTo(8.6);
  });

  it('adds drawtext overlays after assembly', () => {
    const clips = [{ url: 'a.mp4' }];
    const g = buildAssemblyGraph({
      durations: [5],
      clips,
      spec: spec({ clips, texts: [{ text: 'Привет', fromSec: 1, toSec: 3, position: 'bottom' }] }),
      fonts: FONTS,
    });
    expect(g.filterComplex).toContain("drawtext=fontfile=/f/sans.ttf:expansion=none:text='Привет'");
    expect(g.filterComplex).toContain("enable='between(t\\,1\\,3)'");
    expect(g.videoLabel).toBe('[vtxt]');
  });

  it('word-pop captions emit one drawtext per word with its own enable window', () => {
    const clips = [{ url: 'a.mp4' }];
    const g = buildAssemblyGraph({
      durations: [5],
      clips,
      spec: spec({
        clips,
        popText: {
          font: 'display',
          position: 'center',
          words: [
            { text: 'раз', fromSec: 0, toSec: 0.5 },
            { text: 'два', fromSec: 0.5, toSec: 1 },
            { text: 'три', fromSec: 1, toSec: 1.5 },
          ],
        },
      }),
      fonts: FONTS,
    });
    // Three words → three drawtext filters, each with its own enable window, all
    // sharing the one style (display font), routed through the [vpop] label.
    const draws = g.filterComplex.match(/drawtext=/g) ?? [];
    expect(draws).toHaveLength(3);
    expect(g.filterComplex).toContain("drawtext=fontfile=/f/display.ttf:expansion=none:text='раз'");
    expect(g.filterComplex).toContain("text='два'");
    expect(g.filterComplex).toContain("text='три'");
    // Half-open [from,to) — words are adjacency-packed, so an inclusive
    // between() would double-render the shared boundary frame.
    expect(g.filterComplex).toContain("enable='gte(t\\,0)*lt(t\\,0.5)'");
    expect(g.filterComplex).toContain("enable='gte(t\\,0.5)*lt(t\\,1)'");
    expect(g.filterComplex).toContain("enable='gte(t\\,1)*lt(t\\,1.5)'");
    expect(g.videoLabel).toBe('[vpop]');
  });

  it('absent popText leaves the graph byte-identical (no [vpop] lane)', () => {
    const clips = [{ url: 'a.mp4' }];
    const withNone = buildAssemblyGraph({
      durations: [5],
      clips,
      spec: spec({ clips }),
      fonts: FONTS,
    });
    const withEmpty = buildAssemblyGraph({
      durations: [5],
      clips,
      spec: spec({ clips, popText: { words: [] } }),
      fonts: FONTS,
    });
    expect(withNone.filterComplex).not.toContain('[vpop]');
    expect(withEmpty.filterComplex).toBe(withNone.filterComplex);
    expect(withEmpty.videoLabel).toBe(withNone.videoLabel);
  });

  it('mixes music and voiceover with gain, offset and atrim, then loudnorm', () => {
    const clips = [{ url: 'a.mp4' }, { url: 'b.mp4' }];
    const g = buildAssemblyGraph({
      durations: [4, 4],
      clips,
      spec: spec({
        clips,
        music: { url: 'm.mp3', gainDb: -8 },
        voiceover: { url: 'v.mp3', fromSec: 2 },
      }),
      fonts: FONTS,
      musicInput: 2,
      voiceoverInput: 3,
    });
    expect(g.filterComplex).toContain('[2:a]volume=-8dB,atrim=0:8[am]');
    expect(g.filterComplex).toContain('[3:a]volume=0dB,adelay=2000:all=1,atrim=0:8[av]');
    expect(g.filterComplex).toContain('amix=inputs=3:duration=first');
    expect(g.filterComplex).toContain('loudnorm');
  });

  it('applies audio fades around delay/trim in timeline terms', () => {
    const clips = [{ url: 'a.mp4' }];
    const g = buildAssemblyGraph({
      durations: [10],
      clips,
      spec: spec({ clips, music: { url: 'm.mp3', fadeIn: true, fadeOut: true } }),
      fonts: FONTS,
      musicInput: 1,
    });
    expect(g.filterComplex).toContain('afade=t=in:st=0:d=1');
    expect(g.filterComplex).toContain('atrim=0:10,afade=t=out:st=9:d=1');
  });

  it('ducks the music line with a per-window volume expression (eval=frame)', () => {
    const clips = [{ url: 'a.mp4' }];
    const g = buildAssemblyGraph({
      durations: [10],
      clips,
      spec: spec({
        clips,
        music: {
          url: 'm.mp3',
          gainDb: -6,
          duck: { db: -12, segments: [{ fromSec: 2, toSec: 4 }] },
        },
        voiceover: { url: 'v.mp3' },
      }),
      fonts: FONTS,
      musicInput: 1,
      voiceoverInput: 2,
    });
    // The constant gain rides first; the duck volume rides LAST (timeline t) with
    // eval=frame, so it evaluates per output frame.
    expect(g.filterComplex).toContain('[1:a]volume=-6dB,atrim=0:10,');
    // attack starts at 2-0.25=1.75, release ends at 4+0.4=4.4; dB lerp → pow(10,..)
    expect(g.filterComplex).toContain(
      "volume='pow(10\\,(if(lt(t\\,1.75)\\,0\\,if(lt(t\\,2)\\,-12*(t-1.75)/0.25\\," +
        "if(lt(t\\,4)\\,-12\\,if(lt(t\\,4.4)\\,-12*(1-(t-4)/0.4)\\,0)))))/20)':eval=frame",
    );
  });

  it('nests min() across duck windows so overlapping ramps stay ducked', () => {
    const clips = [{ url: 'a.mp4' }];
    const g = buildAssemblyGraph({
      durations: [10],
      clips,
      spec: spec({
        clips,
        music: {
          url: 'm.mp3',
          duck: {
            db: -10,
            segments: [
              { fromSec: 1, toSec: 2 },
              { fromSec: 5, toSec: 6 },
            ],
          },
        },
      }),
      fonts: FONTS,
      musicInput: 1,
    });
    expect(g.filterComplex).toContain('min(');
    // two contributions → exactly one nesting level
    expect((g.filterComplex.match(/min\(/g) ?? []).length).toBe(1);
  });

  it('combines many duck windows as a BALANCED min-tree (ffmpeg parser depth limit)', () => {
    // ffmpeg's recursive expr parser fails on deep right-nesting (~93 segments of
    // min(a,min(b,min(c,…)))). The schema allows 120 windows, so the min-tree MUST
    // stay shallow (⌈log2 120⌉ = 7). Measure the actual min()-nesting depth of the
    // emitted expression; a regression to right-nesting would spike it to ~120.
    const segments = Array.from({ length: 120 }, (_, i) => ({
      fromSec: i * 0.5,
      toSec: i * 0.5 + 0.2,
    }));
    const expr = buildDuckVolumeExpr(segments, -12)!;
    expect((expr.match(/min\(/g) ?? []).length).toBe(119); // N-1 combines, either way
    const maxMinDepth = (s: string): number => {
      let depth = 0;
      let max = 0;
      const stack: boolean[] = [];
      for (let i = 0; i < s.length; i++) {
        if (s[i] === '(') {
          const isMin = s.slice(Math.max(0, i - 3), i) === 'min';
          stack.push(isMin);
          if (isMin) max = Math.max(max, ++depth);
        } else if (s[i] === ')') {
          if (stack.pop()) depth--;
        }
      }
      return max;
    };
    expect(maxMinDepth(expr)).toBeLessThanOrEqual(8); // balanced; right-nested → 120
  });

  it('music without duck stays byte-identical (no eval=frame volume)', () => {
    const clips = [{ url: 'a.mp4' }];
    const withNone = buildAssemblyGraph({
      durations: [10],
      clips,
      spec: spec({ clips, music: { url: 'm.mp3', gainDb: -6 } }),
      fonts: FONTS,
      musicInput: 1,
    });
    const withEmpty = buildAssemblyGraph({
      durations: [10],
      clips,
      spec: spec({ clips, music: { url: 'm.mp3', gainDb: -6, duck: { db: -12, segments: [] } } }),
      fonts: FONTS,
      musicInput: 1,
    });
    expect(withNone.filterComplex).not.toContain('eval=frame');
    // empty segments → no expression → identical to no-duck.
    expect(withEmpty.filterComplex).toBe(withNone.filterComplex);
  });

  it('treats legacy spec.audio as music', () => {
    const clips = [{ url: 'a.mp4' }];
    const g = buildAssemblyGraph({
      durations: [5],
      clips,
      spec: spec({ clips, audio: { url: 'legacy.mp3', gainDb: 3 } }),
      fonts: FONTS,
      musicInput: 1,
    });
    expect(g.filterComplex).toContain('[1:a]volume=3dB,atrim=0:5[am]');
  });

  it('mixes a single timed SFX under the video, trimmed to the timeline', () => {
    const clips = [{ url: 'a.mp4' }];
    const g = buildAssemblyGraph({
      durations: [8],
      clips,
      spec: spec({ clips }),
      fonts: FONTS,
      sfxInputs: [{ inputIdx: 1, atSec: 2 }],
    });
    // 0 dB default, delayed to 2s, trimmed to the 8s video length (never extends it).
    expect(g.filterComplex).toContain('[1:a]volume=0dB,adelay=2000|2000,atrim=0:8[sfx0]');
    // clip audio + one sfx → amix of two, duration=first (video-length governed).
    expect(g.filterComplex).toContain('[0:a][sfx0]amix=inputs=2:duration=first');
    expect(g.totalDuration).toBe(8);
  });

  it('an SFX at atSec 0 gets no adelay', () => {
    const clips = [{ url: 'a.mp4' }];
    const g = buildAssemblyGraph({
      durations: [5],
      clips,
      spec: spec({ clips }),
      fonts: FONTS,
      sfxInputs: [{ inputIdx: 1, atSec: 0 }],
    });
    expect(g.filterComplex).toContain('[1:a]volume=0dB,atrim=0:5[sfx0]');
    expect(g.filterComplex).not.toContain('adelay');
  });

  it('applies SFX gain and joins the mix alongside music', () => {
    const clips = [{ url: 'a.mp4' }];
    const g = buildAssemblyGraph({
      durations: [10],
      clips,
      spec: spec({ clips, music: { url: 'm.mp3', gainDb: -4 } }),
      fonts: FONTS,
      musicInput: 1,
      sfxInputs: [{ inputIdx: 2, atSec: 3, gainDb: -6 }],
    });
    expect(g.filterComplex).toContain('[1:a]volume=-4dB,atrim=0:10[am]');
    expect(g.filterComplex).toContain('[2:a]volume=-6dB,adelay=3000|3000,atrim=0:10[sfx0]');
    // clip audio ⊕ music ⊕ sfx → amix of three.
    expect(g.filterComplex).toContain('[0:a][am][sfx0]amix=inputs=3:duration=first');
  });

  it('rounds the SFX delay to whole milliseconds', () => {
    const clips = [{ url: 'a.mp4' }];
    const g = buildAssemblyGraph({
      durations: [6],
      clips,
      spec: spec({ clips }),
      fonts: FONTS,
      // 1.2345s → round(1234.5) = 1235 ms
      sfxInputs: [{ inputIdx: 1, atSec: 1.2345 }],
    });
    expect(g.filterComplex).toContain('adelay=1235|1235');
  });
});

describe('drawtextFilter', () => {
  it('escapes quotes and colons; % stays literal (expansion=none)', () => {
    expect(escapeDrawtext("it's 100%: ok")).toBe("it\\\\\\'s 100%\\: ok");
    expect(escapeDrawtext('две\nстроки')).toBe('две строки');
  });

  it('uses the serif font and fade alpha when requested', () => {
    const f = drawtextFilter(
      { text: 'X', fromSec: 0, toSec: 2, position: 'center', font: 'serif', fade: true },
      1280,
      720,
      FONTS,
    );
    expect(f).toContain('fontfile=/f/serif.ttf');
    expect(f).toContain('y=(h-text_h)/2');
    expect(f).toContain(':alpha=');
  });

  it('fade envelope matches the preview min-of-both-ramps for a SHORT overlay', () => {
    // preview (PreviewStage `fadeP`): max(0, min(1, (t-from)/0.3, (to-t)/0.3)).
    // For a 0.4s overlay [1.0,1.4] the attack [1.0,1.3] and release [1.1,1.4]
    // ramps OVERLAP; the old sequential if() returned the attack value (0.833)
    // at t=1.25 while the preview was already fading out to 0.5. Sample the REAL
    // emitted alpha expression so a regression to the sequential form fails here.
    const f = drawtextFilter(
      { text: 'X', fromSec: 1.0, toSec: 1.4, position: 'center', font: 'sans', fade: true },
      1280,
      720,
      FONTS,
    );
    // `if` isn't a callable name in JS — rewrite ffmpeg's if(c,a,b) to iff(c,a,b)
    // so BOTH the old sequential-if form and the new min/max form evaluate to a
    // NUMBER (the failure is then a value mismatch, 0.833 vs 0.5, not a parse error).
    const alphaExpr = /:alpha='([^']*)'/
      .exec(f)![1]!
      .replace(/\\,/g, ',')
      .replace(/\bif\(/g, 'iff(');
    const evalAlpha = (t: number) => {
      // ffmpeg's min()/max() are BINARY. Model that exactly so a regression to a
      // 3-arg min (which renders fine in JS but breaks the real drawtext filter)
      // fails HERE, not only in the slow ffmpeg integration test.
      const min = (a: number, b: number, ...rest: number[]) => {
        if (rest.length) throw new Error('ffmpeg min() is binary');
        return Math.min(a, b);
      };
      const max = (a: number, b: number, ...rest: number[]) => {
        if (rest.length) throw new Error('ffmpeg max() is binary');
        return Math.max(a, b);
      };
      const lt = (a: number, b: number) => (a < b ? 1 : 0);
      const gt = (a: number, b: number) => (a > b ? 1 : 0);
      const iff = (c: number, a: number, b: number) => (c ? a : b);
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      return new Function('t', 'min', 'max', 'lt', 'gt', 'iff', `return (${alphaExpr});`)(
        t,
        min,
        max,
        lt,
        gt,
        iff,
      );
    };
    const preview = (t: number) => Math.max(0, Math.min(1, (t - 1.0) / 0.3, (1.4 - t) / 0.3));
    for (const t of [1.0, 1.1, 1.2, 1.25, 1.3, 1.4]) {
      expect(evalAlpha(t)).toBeCloseTo(preview(t), 6);
    }
    // The specific overlap point the sequential form got wrong:
    expect(evalAlpha(1.25)).toBeCloseTo(0.5, 6);
  });

  it('selects the right bundled fontfile per font (sans/serif/display/mono)', () => {
    const at = (font: 'sans' | 'serif' | 'display' | 'mono') =>
      drawtextFilter({ text: 'X', fromSec: 0, toSec: 1, position: 'top', font }, 1280, 720, FONTS);
    expect(at('sans')).toContain('fontfile=/f/sans.ttf');
    expect(at('serif')).toContain('fontfile=/f/serif.ttf');
    expect(at('display')).toContain('fontfile=/f/display.ttf');
    expect(at('mono')).toContain('fontfile=/f/mono.ttf');
  });

  it('auto-shrinks long titles to fit the frame width', () => {
    const long = 'Очень длинный заголовок который не должен вылезать за кадр';
    const f = drawtextFilter(
      { text: long, fromSec: 0, toSec: 2, position: 'bottom' },
      1080,
      1920,
      FONTS,
    );
    const size = Number(/fontsize=(\d+)/.exec(f)![1]);
    expect(size).toBeLessThanOrEqual(Math.floor((1080 * 1.45) / long.length));
    expect(size).toBeGreaterThanOrEqual(12);
  });

  it('no plate stays byte-identical to the legacy chain (white text, no box)', () => {
    const f = drawtextFilter(
      { text: 'X', fromSec: 0, toSec: 1, position: 'top', font: 'sans' },
      1280,
      720,
      FONTS,
    );
    expect(f).toContain(':fontcolor=white:borderw=');
    expect(f).not.toContain('box=');
  });

  it('a dark plate keeps white text and appends the box params', () => {
    const f = drawtextFilter(
      { text: 'X', fromSec: 0, toSec: 1, position: 'bottom', plate: { color: '#101014' } },
      1280,
      720,
      FONTS,
    );
    const size = Number(/fontsize=(\d+)/.exec(f)![1]);
    expect(f).toContain(':fontcolor=#ffffff:');
    expect(f).toContain(`:box=1:boxcolor=#101014:boxborderw=${Math.round(size * 0.35)}`);
  });

  it('a light plate flips the fontcolor to dark', () => {
    const f = drawtextFilter(
      { text: 'X', fromSec: 0, toSec: 1, position: 'bottom', plate: { color: '#ffffff' } },
      1280,
      720,
      FONTS,
    );
    expect(f).toContain(':fontcolor=#0c0e12:');
    expect(f).toContain(':box=1:boxcolor=#ffffff:boxborderw=');
  });
});

describe('buildNormalizeArgs', () => {
  it('applies trim, speed and volume', () => {
    const args = buildNormalizeArgs({
      clip: { url: 'a.mp4', inSec: 1, outSec: 5, speed: 2, volumeDb: -6 },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/out.mp4',
    });
    const joined = args.join(' ');
    expect(joined).toContain('-ss 1 -to 5 -i a.mp4');
    expect(joined).toContain('setpts=PTS/2');
    expect(joined).toContain('-af atempo=2,volume=-6dB');
  });

  it('inserts the color filter chain before speed/fps', () => {
    const args = buildNormalizeArgs({
      clip: { url: 'a.mp4', filter: 'warm', speed: 2 },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain('colortemperature=temperature=4600');
    expect(vf.indexOf('colortemperature')).toBeLessThan(vf.indexOf('setpts'));
    const none = buildNormalizeArgs({
      clip: { url: 'a.mp4', filter: 'none' },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    });
    expect(none[none.indexOf('-vf') + 1]).not.toContain('eq=');
  });

  it('synthesizes silence for mute-source clips and hard-mutes muted clips', () => {
    const silent = buildNormalizeArgs({
      clip: { url: 'a.mp4' },
      hasAudio: false,
      width: 640,
      height: 360,
      fps: 24,
      outFile: '/tmp/o.mp4',
    });
    expect(silent.join(' ')).toContain('anullsrc');
    expect(silent.join(' ')).toContain('-af apad');
    const muted = buildNormalizeArgs({
      clip: { url: 'a.mp4', muted: true },
      hasAudio: true,
      width: 640,
      height: 360,
      fps: 24,
      outFile: '/tmp/o.mp4',
    });
    expect(muted.join(' ')).toContain('volume=-120dB');
  });
});

describe('fitRenderDimensions — aspect-preserving downscale', () => {
  it('scales a 4K 16:9 request to 1920×1080, NOT a squished 1920×1920', () => {
    expect(fitRenderDimensions(3840, 2160)).toEqual({ width: 1920, height: 1080 });
  });
  it('scales a 4K portrait request preserving aspect', () => {
    expect(fitRenderDimensions(2160, 3840)).toEqual({ width: 1080, height: 1920 });
  });
  it('leaves in-range sizes byte-identical (no regression on the common specs)', () => {
    expect(fitRenderDimensions(1280, 720)).toEqual({ width: 1280, height: 720 });
    expect(fitRenderDimensions(1080, 1920)).toEqual({ width: 1080, height: 1920 });
    expect(fitRenderDimensions(1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });
  it('defaults + even-rounds + floors at 64', () => {
    expect(fitRenderDimensions(undefined, undefined)).toEqual({ width: 1280, height: 720 });
    // an odd oversize keeps even output
    const { width, height } = fitRenderDimensions(3841, 2161);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1920);
  });
});

describe('helpers', () => {
  it('clipOutputDuration accounts for trim and speed', () => {
    expect(clipOutputDuration({ url: 'a', inSec: 1, outSec: 5, speed: 2 }, 10)).toBe(2);
    expect(clipOutputDuration({ url: 'a' }, 6)).toBe(6);
  });
  it('clampTransitionSec bounds the range', () => {
    expect(clampTransitionSec(99)).toBe(1.5);
    expect(clampTransitionSec(0)).toBe(0.2);
    expect(clampTransitionSec(undefined)).toBe(0.5);
  });
});

describe('silent timeline assembly', () => {
  it('does not run loudnorm over digital silence', () => {
    const graph = buildAssemblyGraph({
      durations: [1],
      clips: [{ url: 'silent.mp4' }],
      spec: { clips: [{ url: 'silent.mp4' }], width: 320, height: 180 },
      fonts: FONTS,
      applyLoudnessNormalization: false,
    });
    expect(graph.filterComplex).toContain('[0:a]anull[aout]');
    expect(graph.filterComplex).not.toContain('loudnorm');
  });
});

describe('transform (editor E2)', () => {
  it('clampTransform: absent/identity → null (legacy chain stays)', () => {
    expect(clampTransform(undefined)).toBeNull();
    expect(clampTransform({})).toBeNull();
    expect(clampTransform({ scale: 1, posX: 0, rotate: 0, crop: { left: 0 } })).toBeNull();
  });

  it('clampTransform clamps to UI ranges', () => {
    const t = clampTransform({ scale: 99, posX: -500, rotate: 720, crop: { left: 0.9 } })!;
    expect(t).toMatchObject({ scale: 3, posX: -100, rotate: 180 });
    expect(t.crop.left).toBe(0.45);
  });

  it('identity clip args are byte-identical to the legacy chain', () => {
    const base = {
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    };
    const legacy = buildNormalizeArgs({ ...base, clip: { url: 'a.mp4' } });
    const withIdentity = buildNormalizeArgs({
      ...base,
      clip: { url: 'a.mp4', transform: { scale: 1, posX: 0, posY: 0, rotate: 0 } },
    });
    expect(withIdentity).toEqual(legacy);
    expect(legacy.join(' ')).toContain('-vf scale=1280:720');
  });

  it('transformed clip composites via filter_complex (crop→fit→scale→rotate→overlay)', () => {
    const args = buildNormalizeArgs({
      clip: {
        url: 'a.mp4',
        speed: 2,
        filter: 'warm',
        transform: { scale: 1.5, posX: 10, posY: -5, rotate: 15, crop: { left: 0.1, top: 0.2 } },
      },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    });
    const joined = args.join(' ');
    expect(joined).toContain('-filter_complex');
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    // layer order is load-bearing: crop first, then fit, user scale, colour, rotate
    expect(graph).toMatch(
      /crop=iw\*0\.9:ih\*0\.8:iw\*0\.1:ih\*0\.2,scale=1280:720:force_original_aspect_ratio=decrease,scale=trunc\(iw\*1\.5\/2\)\*2:trunc\(ih\*1\.5\/2\)\*2,colortemperature/,
    );
    expect(graph).toContain('rotate=15*PI/180:c=black@0');
    // posX 10% of 1280 = 128; posY -5% of 720 = -36
    expect(graph).toContain('overlay=x=(W-w)/2+128:y=(H-h)/2+-36');
    // speed lives AFTER the composite; audio chain unchanged
    expect(graph).toContain('setpts=PTS/2');
    expect(joined).toContain('-map [vout] -map 0:a:0');
    expect(joined).toContain('-af atempo=2');
  });
});

describe('colour grade (editor E3)', () => {
  it('absent/neutral grade → null (legacy args untouched)', () => {
    expect(buildColorChain(undefined)).toBeNull();
    expect(buildColorChain({})).toBeNull();
    expect(buildColorChain({ brightness: 0, vignette: 0 })).toBeNull();
  });

  it('maps sliders to eq/colortemperature/curves/vignette/noise in order', () => {
    const chain = buildColorChain({
      brightness: 50,
      contrast: -40,
      saturation: 100,
      temperature: 100,
      highlight: -50,
      shadow: 50,
      vignette: 100,
      grain: 50,
    })!;
    expect(chain).toContain('eq=brightness=0.15:contrast=0.8:saturation=2');
    expect(chain).toContain('colortemperature=temperature=3900');
    expect(chain).toContain("curves=all='0/0 0.25/0.325 0.75/0.675 1/1'");
    expect(chain).toContain('vignette=a=1.571');
    expect(chain).toContain('noise=alls=10:allf=t+u');
    // chain order mirrors the CSS stack
    expect(chain.indexOf('eq=')).toBeLessThan(chain.indexOf('colortemperature'));
    expect(chain.indexOf('curves')).toBeLessThan(chain.indexOf('vignette'));
  });

  it('the 6 curated "Looks" presets compile to their ffmpeg fragments', () => {
    expect(buildColorChain({ curve: 'warm-film' })).toBe(
      `eq=saturation=1.1:contrast=1.06:brightness=0.02,curves=r='0/0.04 1/1':b='0/0 1/0.9'`,
    );
    expect(buildColorChain({ curve: 'cool-film' })).toBe(
      `hue=h=-10:s=0.92,eq=contrast=1.05:brightness=0.01`,
    );
    expect(buildColorChain({ curve: 'noir' })).toBe(
      `eq=saturation=0.2:contrast=1.35:brightness=-0.06`,
    );
    expect(buildColorChain({ curve: 'teal-orange' })).toBe(`hue=h=8:s=1.35,eq=contrast=1.1`);
    expect(buildColorChain({ curve: 'bleach-bypass' })).toBe(
      `eq=saturation=0.5:contrast=1.4:brightness=0.08`,
    );
    expect(buildColorChain({ curve: 'faded-polaroid' })).toBe(
      `eq=contrast=0.8:brightness=0.1,curves=r='0/0.03 1/1':b='0/0 1/0.94'`,
    );
    // the original 7 presets are untouched by the new entries
    expect(buildColorChain({ curve: 'vintage' })).toBe(
      `curves=all='0/0.1 0.5/0.52 1/0.9':b='0/0.06 1/0.92'`,
    );
  });

  it('grade appends after the legacy preset in normalize args', () => {
    const args = buildNormalizeArgs({
      clip: { url: 'a.mp4', filter: 'warm', color: { saturation: 20 } },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toMatch(
      /colortemperature=temperature=4600,eq=saturation=1\.12:contrast=1\.04,eq=saturation=1\.2/,
    );
  });

  it('clamps out-of-range sliders', () => {
    const chain = buildColorChain({ saturation: -500, temperature: 999 })!;
    expect(chain).toContain('saturation=0');
    expect(chain).toContain('temperature=3900');
  });
});

describe('clip toolbar ops (editor E4)', () => {
  const base = { hasAudio: true, width: 1280, height: 720, fps: 30, outFile: '/tmp/o.mp4' };

  it('reverse → video reverse after framing + areverse first in audio', () => {
    const args = buildNormalizeArgs({ ...base, clip: { url: 'a.mp4', reversed: true, speed: 2 } });
    const joined = args.join(' ');
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toMatch(/setsar=1,reverse,setpts=PTS\/2/);
    expect(joined).toContain('-af areverse,atempo=2');
  });

  it('flips slot in after setsar, before colour', () => {
    const args = buildNormalizeArgs({
      ...base,
      clip: { url: 'a.mp4', flipH: true, flipV: true, filter: 'mono' },
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toMatch(/setsar=1,hflip,vflip,hue=s=0/);
  });

  it('freeze: single frame clone-padded, silent audio, -t cap; speed/trim ignored', () => {
    const args = buildNormalizeArgs({
      ...base,
      clip: { url: 'a.mp4', inSec: 1, outSec: 5, speed: 2, freeze: { atSec: 2.5, durSec: 3 } },
    });
    const joined = args.join(' ');
    expect(joined).toContain('-ss 2.5 -i a.mp4');
    expect(joined).not.toContain('-to'); // trim ignored
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain('trim=end_frame=1,setpts=PTS-STARTPTS');
    expect(vf).toContain('tpad=stop_mode=clone:stop_duration=3');
    expect(vf).not.toContain('setpts=PTS/2'); // no speed on a still
    expect(joined).toContain('anullsrc'); // silent line even though hasAudio
    expect(joined).toContain('-map 1:a:0');
    expect(joined).toContain('-t 3');
  });

  it('clipOutputDuration: freeze wins over trim/speed', () => {
    expect(
      clipOutputDuration(
        { url: 'a', inSec: 0, outSec: 8, speed: 2, freeze: { atSec: 1, durSec: 3 } },
        10,
      ),
    ).toBe(3);
    expect(clipOutputDuration({ url: 'a', freeze: { atSec: 0, durSec: 99 } }, 10)).toBe(10);
  });

  it('reverse + flips compose with a transform via the composite graph', () => {
    const args = buildNormalizeArgs({
      ...base,
      clip: { url: 'a.mp4', reversed: true, flipH: true, transform: { scale: 1.2 } },
    });
    const graph = args[args.indexOf('-filter_complex') + 1]!;
    expect(graph).toContain('hflip');
    expect(graph).toMatch(/setsar=1,reverse,fps=30/);
  });
});

describe('speed upgrade (editor E5)', () => {
  it('widened speeds chain atempo in equal in-range factors', () => {
    expect(buildAtempoChain(1)).toEqual([]);
    expect(buildAtempoChain(2)).toEqual(['atempo=2']);
    expect(buildAtempoChain(4)).toEqual(['atempo=2', 'atempo=2']);
    expect(buildAtempoChain(0.25)).toEqual(['atempo=0.5', 'atempo=0.5']);
    expect(buildAtempoChain(3)).toEqual(['atempo=1.732', 'atempo=1.732']);
  });

  it('buildSpeedRamp: hero over 10s — piecewise expr, exact duration, matching avg', () => {
    const r = buildSpeedRamp('hero', 10);
    // 3/1.8 + 4/0.45 + 3/1.8 = 1.667+8.889+1.667 = 12.222s
    expect(r.outDuration).toBeCloseTo(12.222, 2);
    expect(r.avgSpeed).toBeCloseTo(10 / 12.222, 3);
    expect(r.setpts).toContain("setpts='(if(lt(T\\,3)\\,0+(T-0)/1.8\\,");
    expect(r.setpts).toContain('/TB');
  });

  it('speedCurve drives normalize args: ramped setpts + average atempo', () => {
    const args = buildNormalizeArgs({
      clip: { url: 'a.mp4', inSec: 0, outSec: 10, speedCurve: 'flash' },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain("setpts='(if(lt(T");
    const joined = args.join(' ');
    // flash avg = 10 / (7/0.6 + 3/2.4) = 10/12.917 ≈ 0.774
    expect(joined).toContain('-af atempo=0.774');
  });

  it('clipOutputDuration accounts for the ramp', () => {
    expect(
      clipOutputDuration({ url: 'a', inSec: 0, outSec: 10, speedCurve: 'montage' }, 10),
    ).toBeCloseTo((10 * 0.4) / 0.6 + (10 * 0.6) / 1.6, 2);
  });

  it('curve without trim bounds falls back to uniform speed', () => {
    const args = buildNormalizeArgs({
      clip: { url: 'a.mp4', speedCurve: 'hero', speed: 2 },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    });
    expect(args[args.indexOf('-vf') + 1]!).toContain('setpts=PTS/2');
  });
});

describe('animation in/out (editor E6)', () => {
  it('fade in + out land in output time after setpts', () => {
    const args = buildNormalizeArgs({
      clip: {
        url: 'a.mp4',
        inSec: 0,
        outSec: 8,
        speed: 2,
        animIn: { kind: 'fade', durSec: 0.5 },
        animOut: { kind: 'fade', durSec: 0.5 },
      },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    // outDur = 8/2 = 4s → fade out starts at 3.5
    expect(vf).toMatch(/setpts=PTS\/2,fade=t=in:st=0:d=0\.5,fade=t=out:st=3\.5:d=0\.5,fps=30/);
  });

  it('zoom uses the crop-settle (1.2→1); slide pads 3W and animates the window', () => {
    const args = buildNormalizeArgs({
      clip: {
        url: 'a.mp4',
        inSec: 0,
        outSec: 4,
        animIn: { kind: 'zoom', durSec: 1 },
        animOut: { kind: 'slide', durSec: 1 },
      },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain("zoompan=z='1+0.2*(1-min(it/1,1))'");
    expect(vf).toContain('pad=w=3*1280:h=720:x=1280:y=0');
    expect(vf).toContain("crop=1280:720:x='1280-1280*max(0,(t-3)/1)':y=0");
  });

  it('exit animation is skipped without a known duration', () => {
    const args = buildNormalizeArgs({
      clip: { url: 'a.mp4', animOut: { kind: 'fade', durSec: 0.5 } },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    });
    expect(args[args.indexOf('-vf') + 1]!).not.toContain('fade=t=out');
  });
});

describe('keyframes (editor E7, phase 1)', () => {
  it('kfExpr compiles piecewise-linear with hold semantics', () => {
    expect(kfExpr([])).toBe('0');
    expect(kfExpr([{ t: 1, v: 5 }])).toBe('5');
    const e = kfExpr([
      { t: 1, v: 0 },
      { t: 3, v: 10 },
    ]);
    expect(e).toBe('if(lt(t,1),0,if(lt(t,3),0+(10-0)*(t-1)/2,10))');
  });

  it('buildKeyframeChain emits rotate/zoompan/pan-crop/opacity-geq', () => {
    const chain = buildKeyframeChain({
      keyframes: {
        rotate: [
          { t: 0, v: 0 },
          { t: 2, v: 90 },
        ],
        scale: [
          { t: 0, v: 1 },
          { t: 2, v: 2 },
        ],
        posX: [
          { t: 0, v: 0 },
          { t: 2, v: 50 },
        ],
        opacity: [
          { t: 0, v: 1 },
          { t: 2, v: 0 },
        ],
      },
      width: 1280,
      height: 720,
      fps: 30,
    });
    const all = chain.join(',');
    expect(all).toContain("rotate=a='(if(lt(t,0),0,if(lt(t,2),0+(90-0)*(t-0)/2,90)))*PI/180'");
    expect(all).toContain("zoompan=z='if(lt(it,0),1,if(lt(it,2),1+(2-1)*(it-0)/2,2))'");
    expect(all).toContain('pad=w=3*1280:h=3*720');
    expect(all).toContain("geq=r='r(X,Y)*clip(");
  });

  it('keyframed clip appends the chain after anims in normalize args', () => {
    const args = buildNormalizeArgs({
      clip: {
        url: 'a.mp4',
        inSec: 0,
        outSec: 4,
        keyframes: {
          posY: [
            { t: 0, v: 0 },
            { t: 4, v: -30 },
          ],
        },
      },
      hasAudio: true,
      width: 1280,
      height: 720,
      fps: 30,
      outFile: '/tmp/o.mp4',
    });
    const vf = args[args.indexOf('-vf') + 1]!;
    expect(vf).toContain(
      "crop=1280:720:x='1280-(0)':y='720-((if(lt(t,0),0,if(lt(t,4),0+(-30-0)*(t-0)/4,-30)))*720/100)'",
    );
  });
});

describe('multi-track PiP overlays (editor E8)', () => {
  const baseInput = () => ({
    durations: [10],
    clips: [{ url: 'a.mp4' }] as StudioClip[],
    spec: spec({ clips: [{ url: 'a.mp4' }], width: 1280, height: 720 }),
    fonts: FONTS,
  });

  it('composites each PiP with trim/shift/scale/opacity + between window', () => {
    const g = buildAssemblyGraph({
      ...baseInput(),
      overlays: [
        {
          inputIdx: 1,
          sourceDur: 8,
          hasAudio: true,
          clip: {
            url: 'pip.mp4',
            atSec: 2,
            inSec: 1,
            outSec: 4,
            scale: 0.4,
            posX: -20,
            posY: 10,
            opacity: 0.8,
          },
        },
      ],
    });
    const fc = g.filterComplex;
    expect(fc).toContain(
      '[1:v]trim=start=1:end=4,setpts=PTS-STARTPTS+2/TB,scale=trunc(1280*0.4/2)*2:-2,format=rgba,colorchannelmixer=aa=0.8[pip0]',
    );
    // posX -20% of 1280 = -256; posY 10% of 720 = 72; window 2..5
    expect(fc).toContain(
      "overlay=x=(W-w)/2+-256:y=(H-h)/2+72:enable='between(t,2,5)':eof_action=pass[vpip0]",
    );
    // audio joins the mix delayed to 2s
    expect(fc).toContain('[1:a]atrim=1:4,asetpts=PTS-STARTPTS,adelay=2000:all=1,atrim=0:10[apip0]');
    expect(fc).toContain('amix=inputs=2');
    expect(g.videoLabel).toBe('[vpip0]');
  });

  it('muted/audio-less PiPs stay out of the mix; defaults place top-right at 0.35', () => {
    const g = buildAssemblyGraph({
      ...baseInput(),
      overlays: [{ inputIdx: 1, sourceDur: 3, hasAudio: false, clip: { url: 'p.mp4', atSec: 0 } }],
    });
    expect(g.filterComplex).toContain('scale=trunc(1280*0.35/2)*2:-2');
    expect(g.filterComplex).toContain('overlay=x=(W-w)/2+358:y=(H-h)/2+-202');
    expect(g.filterComplex).not.toContain('apip0');
    // single audio line → no amix, straight to loudnorm
    expect(g.filterComplex).toContain('[0:a]loudnorm');
  });
});

describe('upper-track alpha layers (Phase II)', () => {
  const base = { hasAudio: true, width: 1280, height: 720, fps: 30, outFile: '/tmp/tl0.mov' };

  it('normalizes an upper-track clip onto a TRANSPARENT canvas as ProRes-4444', () => {
    const args = buildNormalizeArgs({
      ...base,
      alpha: true,
      clip: {
        url: 'ov.mp4',
        transform: { rotate: 30, scale: 0.5 },
        color: { saturation: 90 },
        opacity: 0.8,
      },
    });
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    // transparent base + alpha-preserving output, the grade + rotation baked in
    expect(fc).toContain('color=black@0:s=1280x720');
    expect(fc).toContain('format=yuva444p10le');
    expect(fc).toContain('eq=saturation=1.9');
    expect(fc).toContain('rotate=30*PI/180');
    // static opacity baked into the alpha channel
    expect(fc).toContain('colorchannelmixer=aa=0.8');
    // alpha codec tail, and NOT the H.264 base-track tail
    expect(args.join(' ')).toContain('-c:v prores_ks -profile:v 4444 -pix_fmt yuva444p10le');
    expect(args).not.toContain('-video_track_timescale');
  });

  it('an identity-transform alpha clip still composites onto a transparent canvas', () => {
    const args = buildNormalizeArgs({ ...base, alpha: true, clip: { url: 'ov.mp4' } });
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    expect(fc).toContain('color=black@0:s=1280x720');
    expect(fc).toContain('format=yuva444p10le');
  });

  it('does NOT apply mask/blend on an alpha layer (gated to the base track)', () => {
    const args = buildNormalizeArgs({
      ...base,
      alpha: true,
      clip: { url: 'ov.mp4', mask: { shape: 'circle' }, blendMode: 'multiply' },
    });
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    expect(fc).not.toContain('geq'); // mask/blend would emit a per-pixel geq
  });

  it('does NOT apply keyframes/anims on an alpha layer (they break transparency)', () => {
    const args = buildNormalizeArgs({
      ...base,
      alpha: true,
      clip: {
        url: 'ov.mp4',
        inSec: 0,
        outSec: 3,
        animIn: { kind: 'slide', durSec: 0.5 },
        animOut: { kind: 'fade', durSec: 0.5 },
        keyframes: {
          opacity: [
            { t: 0, v: 0 },
            { t: 1, v: 1 },
          ],
        },
      },
    });
    const fc = args[args.indexOf('-filter_complex') + 1]!;
    // slide pads opaque black; opacity keyframe uses geq → both would wreck alpha.
    expect(fc).not.toContain('pad=w=3*');
    expect(fc).not.toContain('geq');
    expect(fc).not.toContain('fade=');
  });

  it('composites pre-normalized track layers with a time-shift + alpha overlay', () => {
    const g = buildAssemblyGraph({
      durations: [10],
      clips: [{ url: 'a.mp4' }] as StudioClip[],
      spec: spec({ clips: [{ url: 'a.mp4' }], width: 1280, height: 720 }),
      fonts: FONTS,
      trackLayers: [{ inputIdx: 1, startSec: 2, outDuration: 3, hasAudio: true }],
    });
    const fc = g.filterComplex;
    expect(fc).toContain('[1:v]setpts=PTS-STARTPTS+2/TB[tl0]');
    expect(fc).toContain("overlay=0:0:enable='between(t,2,5)':eof_action=pass[vtl0]");
    // its (already-baked) audio rides in at startSec
    expect(fc).toContain('adelay=2000:all=1');
    expect(fc).toContain('amix=inputs=2');
    expect(g.videoLabel).toBe('[vtl0]');
  });

  it('muted track layers stay out of the audio mix', () => {
    const g = buildAssemblyGraph({
      durations: [10],
      clips: [{ url: 'a.mp4' }] as StudioClip[],
      spec: spec({ clips: [{ url: 'a.mp4' }] }),
      fonts: FONTS,
      trackLayers: [{ inputIdx: 1, startSec: 0, outDuration: 3, hasAudio: true, muted: true }],
    });
    expect(g.filterComplex).not.toContain('atl0');
    expect(g.filterComplex).toContain('[0:a]loudnorm');
  });
});

describe('mask shapes (S3 subsystem C)', () => {
  const bg: [number, number, number] = [0, 0, 0];

  it('diamond emits an L1-distance geq alpha', () => {
    const fc = buildMaskBlendChain({ mask: { shape: 'diamond' }, bg })!;
    expect(fc).toContain('geq=');
    expect(fc).toContain('abs(X-W/2)/(W/2)+abs(Y-H/2)/(H/2)');
  });

  it('star emits a polar-wedge boundary geq alpha', () => {
    const fc = buildMaskBlendChain({ mask: { shape: 'star' }, bg })!;
    expect(fc).toContain('geq=');
    expect(fc).toContain('atan2(Y-H/2,X-W/2)');
    expect(fc).toContain('2*PI/5');
  });

  it('star boundary radius: a tip sits straight up, matching the CSS/SVG star (STAR_PATH)', () => {
    // Reimplements the same closed-form polar boundary as the geq expression
    // (see the star branch of buildMaskBlendChain) as plain JS, so we can
    // numerically sample it instead of string-matching the ffmpeg expression
    // (a string match would have passed even with the rotated/broken formula).
    const sin36 = Math.sin(Math.PI / 5);
    const cos36 = Math.cos(Math.PI / 5);
    const ratio = 0.5;
    const router = 1; // min(W,H)/2, normalised
    const rinner = router * ratio;
    const a = rinner * sin36;
    const b = router - rinner * cos36;
    const cc = router * rinner * sin36;
    const mod = (x: number, y: number) => ((x % y) + y) % y;
    // Mirrors: mod(atan2(Y-H/2,X-W/2)+PI/2+PI/5+4*PI,2*PI/5)-PI/5
    const phiOf = (theta: number) =>
      mod(theta + Math.PI / 2 + Math.PI / 5 + 4 * Math.PI, (2 * Math.PI) / 5) - Math.PI / 5;
    const rBoundary = (theta: number) =>
      cc / (a * Math.cos(Math.abs(phiOf(theta))) + b * Math.sin(Math.abs(phiOf(theta))));

    const thetaUp = -Math.PI / 2; // atan2(Y-H/2,X-W/2) for the straight-up screen direction
    expect(rBoundary(thetaUp)).toBeCloseTo(router, 6); // tip: outer radius, matching STAR_PATH's top-center point (50,0)

    const thetaValley = thetaUp + Math.PI / 5; // 36° over — the adjacent valley
    expect(rBoundary(thetaValley)).toBeCloseTo(rinner, 6);
    expect(rBoundary(thetaValley)).toBeLessThan(rBoundary(thetaUp));

    // Tips recur every 72° (2*PI/5) for a 5-point star.
    for (let k = -2; k <= 2; k++) {
      expect(rBoundary(thetaUp + k * ((2 * Math.PI) / 5))).toBeCloseTo(router, 6);
    }
  });

  it('star valley radius matches STAR_PATH (0.382·R), sampling the REAL emitted geq', () => {
    // The test above re-uses the worker's OWN ratio constant, so it can't catch a
    // wrong ratio. This one derives the expected inner radius from the CSS star
    // path (STAR_PATH, a 0–100 viewBox centred at 50,50) and probes the actual
    // emitted geq string along the valley ray — so it FAILS on ratio=0.5 and
    // passes only when the export star has the same fatness as the preview.
    const STAR_PATH: [number, number][] = [
      [50, 0],
      [61, 35],
      [98, 35],
      [68, 57],
      [79, 91],
      [50, 70],
      [21, 91],
      [32, 57],
      [2, 35],
      [39, 35],
    ];
    const outerR =
      [0, 2, 4, 6, 8].reduce(
        (s, i) => s + Math.hypot(STAR_PATH[i]![0] - 50, STAR_PATH[i]![1] - 50),
        0,
      ) / 5;
    const innerR =
      [1, 3, 5, 7, 9].reduce(
        (s, i) => s + Math.hypot(STAR_PATH[i]![0] - 50, STAR_PATH[i]![1] - 50),
        0,
      ) / 5;
    const ratio = innerR / outerR; // ≈ 0.382 (canonical pentagram)
    expect(ratio).toBeGreaterThan(0.37);
    expect(ratio).toBeLessThan(0.4);

    // The emitted shape alpha: ~1 inside the star, ~0 outside (default feather is
    // a hard 0.006 band). Probe along the valley direction at a radius that lies
    // OUTSIDE a 0.382 star but INSIDE a (buggy) 0.5 star.
    const fc = buildMaskBlendChain({ mask: { shape: 'star' }, bg })!;
    // pull the shape sub-expression out of the r channel lerp (…-R)*(shape)):
    const shape = fc.match(/geq=r='0\+\(\(r\(X,Y\)\)-0\)\*\(([^\n]*?)\)':g=/)![1]!;
    // Valley direction in screen coords: straight up (−90°) rotated +36°.
    const thetaValley = -Math.PI / 2 + Math.PI / 5;
    // ρ in units of min(W,H)/2 = 50. Point at ρ along the valley ray.
    const at = (rho: number) => {
      const nx = (50 + rho * 50 * Math.cos(thetaValley)) / 100;
      const ny = (50 + rho * 50 * Math.sin(thetaValley)) / 100;
      return evalGeq(shape, nx, ny);
    };
    expect(at(0.3)).toBeGreaterThan(0.9); // well inside either star
    // ρ=0.44 is outside a 0.382 star (correct) but inside a 0.5 star (bug):
    expect(at(0.44)).toBeLessThan(0.1);
  });

  it('heart emits the implicit-curve geq alpha', () => {
    const fc = buildMaskBlendChain({ mask: { shape: 'heart' }, bg })!;
    expect(fc).toContain('geq=');
    expect(fc).toContain('-1))*((');
  });

  it('cinematic-bars emits a hard top/bottom letterbox geq alpha', () => {
    const fc = buildMaskBlendChain({ mask: { shape: 'cinematic-bars' }, bg })!;
    expect(fc).toContain('geq=');
    expect(fc).toContain('if(lt(Y,H*0.12),0,if(gt(Y,H*0.88),0,1))');
  });

  it('invert flips the alpha for a new shape same as the existing ones', () => {
    const fc = buildMaskBlendChain({ mask: { shape: 'diamond', invert: true }, bg })!;
    expect(fc).toContain('(1-(clip(');
  });

  it('is null for a clip with no mask and full opacity (byte-identical legacy path)', () => {
    expect(buildMaskBlendChain({ bg })).toBeNull();
  });
});

// Evaluate an emitted geq boolean the way ffmpeg would: substitute its expr
// functions with JS equivalents and probe a normalized point (nx,ny)∈[0,1].
// W=H=100 so X=nx·100, Y=ny·100 — this exercises the REAL emitted string, not a
// re-implementation, so a bug in expression generation shows up here.
function evalGeq(expr: string, nx: number, ny: number): number {
  const gt = (a: number, b: number) => (a > b ? 1 : 0);
  const lt = (a: number, b: number) => (a < b ? 1 : 0);
  const mod = (a: number, b: number) => ((a % b) + b) % b;
  const clip = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const { min, hypot, abs, cos, sin, atan2, PI } = Math;
  const W = 100;
  const H = 100;
  const X = nx * W;
  const Y = ny * H;
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  const fn = new Function(
    'gt',
    'lt',
    'mod',
    'clip',
    'min',
    'hypot',
    'abs',
    'cos',
    'sin',
    'atan2',
    'PI',
    'W',
    'H',
    'X',
    'Y',
    `return (${expr});`,
  );
  return fn(gt, lt, mod, clip, min, hypot, abs, cos, sin, atan2, PI, W, H, X, Y);
}

describe('freeform mask — point-in-polygon geq (editor S3-C)', () => {
  it('classifies inside/outside a simple square (hard edge)', () => {
    const square = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
    ];
    const expr = freeformMaskExpr(square, 0);
    // A hard mask is a bare parity test → 0 or 1 exactly.
    expect(expr.startsWith('mod(')).toBe(true);
    expect(evalGeq(expr, 0.5, 0.5)).toBe(1); // dead centre — inside
    expect(evalGeq(expr, 0.3, 0.7)).toBe(1); // off-centre but inside
    expect(evalGeq(expr, 0.05, 0.5)).toBe(0); // left of the box — outside
    expect(evalGeq(expr, 0.95, 0.5)).toBe(0); // right of the box — outside
    expect(evalGeq(expr, 0.5, 0.05)).toBe(0); // above — outside
    expect(evalGeq(expr, 0.5, 0.95)).toBe(0); // below — outside
  });

  it('classifies inside/outside a simple triangle (hard edge)', () => {
    // Apex up; base along the bottom.
    const tri = [
      { x: 0.5, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
    ];
    const expr = freeformMaskExpr(tri, 0);
    expect(evalGeq(expr, 0.5, 0.6)).toBe(1); // inside the body
    expect(evalGeq(expr, 0.5, 0.3)).toBe(1); // just under the apex
    expect(evalGeq(expr, 0.25, 0.3)).toBe(0); // upper-left, outside the slope
    expect(evalGeq(expr, 0.5, 0.9)).toBe(0); // below the base
    expect(evalGeq(expr, 0.1, 0.5)).toBe(0); // far left — outside
  });

  it('feather ramps the inner edge but keeps the outside hard-zero', () => {
    const square = [
      { x: 0.2, y: 0.2 },
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.2, y: 0.8 },
    ];
    const expr = freeformMaskExpr(square, 60); // feather band ≈ 0.24 of frame
    expect(evalGeq(expr, 0.5, 0.5)).toBe(1); // deep inside — fully opaque
    const nearEdge = evalGeq(expr, 0.5, 0.24); // just inside the top edge
    expect(nearEdge).toBeGreaterThan(0);
    expect(nearEdge).toBeLessThan(1); // ramped, not full
    expect(evalGeq(expr, 0.5, 0.1)).toBe(0); // outside stays hard 0
  });

  it('returns empty for a degenerate (<3-point) polygon', () => {
    expect(freeformMaskExpr([{ x: 0.1, y: 0.1 }], 0)).toBe('');
    expect(freeformMaskExpr([], 20)).toBe('');
  });
});

describe('buildMaskBlendChain — freeform integration (S3-C)', () => {
  const bg: [number, number, number] = [0, 0, 0];
  const square = [
    { x: 0.2, y: 0.2 },
    { x: 0.8, y: 0.2 },
    { x: 0.8, y: 0.8 },
    { x: 0.2, y: 0.8 },
  ];

  it('emits a per-pixel geq lerp for a valid freeform polygon', () => {
    const chain = buildMaskBlendChain({ mask: { shape: 'freeform', points: square }, bg });
    expect(chain).not.toBeNull();
    expect(chain).toContain('geq=');
    expect(chain).toContain('mod('); // the parity inside-test
  });

  it('inverts the polygon (1 − shape) when invert is set', () => {
    const chain = buildMaskBlendChain({
      mask: { shape: 'freeform', points: square, invert: true },
      bg,
    })!;
    expect(chain).toContain('(1-(mod(');
  });

  it('treats a <3-point freeform mask as no mask (null when otherwise neutral)', () => {
    expect(
      buildMaskBlendChain({ mask: { shape: 'freeform', points: [{ x: 0.1, y: 0.1 }] }, bg }),
    ).toBeNull();
  });

  it('leaves the circle/rect/linear shapes byte-identical (no regression)', () => {
    // Sanity anchor: the freeform branch must not perturb the legacy shapes.
    expect(buildMaskBlendChain({ mask: { shape: 'circle' }, bg })).toContain(
      'clip((1-(hypot(X-W/2,Y-H/2)/(min(W,H)/2)))',
    );
  });
});
