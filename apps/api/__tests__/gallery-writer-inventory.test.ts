import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = resolve(import.meta.dirname, '../../..');
const productionSources = [
  'apps/api/src/folders.ts',
  'apps/worker/src/job-runner.ts',
  'apps/worker/src/studio-render.ts',
] as const;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

describe('gallery writer inventory', () => {
  it('keeps the complete production gallery_items writer surface explicit', () => {
    const writers = sourceFiles(resolve(repositoryRoot, 'apps'))
      .filter(
        (path) =>
          path.includes('/src/') &&
          !path.endsWith('.test.ts') &&
          !path.endsWith('.integration.test.ts') &&
          !path.includes('/test-support/'),
      )
      .flatMap((path) => {
        const source = readFileSync(path, 'utf8');
        return [...source.matchAll(/insert\(galleryItems\)/g)].map(() =>
          path.slice(repositoryRoot.length + 1),
        );
      });

    expect(writers).toEqual([...productionSources]);
  });
});
