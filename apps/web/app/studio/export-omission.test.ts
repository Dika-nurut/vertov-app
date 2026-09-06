import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Export omission contract: zero gains are trimmed from the render body because
// the worker treats a missing gainDb as 0 (studio-graph addTrack default).
// Non-zero gains must always be sent. Mirrors the sfx/clip convention.
describe('studio export gain omission', () => {
  const src = readFileSync(join(__dirname, 'useStudioExport.ts'), 'utf8');

  it('omits music gainDb when 0, sends when non-zero', () => {
    expect(src).toContain('...(music.gainDb !== 0 ? { gainDb: music.gainDb } : {})');
  });

  it('omits voiceover gainDb when 0, sends when non-zero', () => {
    expect(src).toContain('...(voiceover.gainDb !== 0 ? { gainDb: voiceover.gainDb } : {})');
  });

  it('keeps the sfx/clip omission convention intact', () => {
    expect(src).toContain('...(s.gainDb !== 0 ? { gainDb: s.gainDb } : {})');
  });
});
