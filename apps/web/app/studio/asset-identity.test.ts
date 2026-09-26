import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const EMPTY_STAGE = readFileSync(join(__dirname, '_preview/EmptyStage.tsx'), 'utf8');
const MEDIA_PANEL = readFileSync(join(__dirname, '_library/MediaPanel.tsx'), 'utf8');

describe('Studio asset identity wiring', () => {
  it('passes the stable asset identity, not the source tile UI id', () => {
    expect(EMPTY_STAGE).toContain('addClip(c.assetUrl, c.assetId)');
    expect(MEDIA_PANEL).toContain('addClip(c.assetUrl, c.assetId)');
    expect(MEDIA_PANEL).toContain('addPip(c.assetUrl, c.assetId)');
    expect(EMPTY_STAGE).not.toContain('addClip(c.assetUrl, c.id)');
    expect(MEDIA_PANEL).not.toContain('addClip(c.assetUrl, c.id)');
    expect(MEDIA_PANEL).not.toContain('addPip(c.assetUrl, c.id)');
  });
});
