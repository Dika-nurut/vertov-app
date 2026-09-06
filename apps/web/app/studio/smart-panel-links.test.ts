import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SmartPanel } from './_inspector/SmartPanel';
import { StudioProjectProvider } from './_project-context';
import { DEFAULT_TRANSFORM, SMART_ROUTES, type TClip } from './_model';

/**
 * SmartPanel's «умные инструменты» hand off to Борды. In project mode that
 * hand-off has to carry the active Среда project, or the work it starts lands
 * in the global library instead of the project. Renders the REAL component
 * inside the real provider — the href has to come out of the component, not
 * out of a grep over its source.
 */

const clip: TClip = {
  uid: 'clip-1',
  url: '/fixtures/clip.mp4',
  dur: 4,
  inSec: 0,
  outSec: 4,
  speed: 1,
  muted: false,
  volumeDb: 0,
  transition: 'cut',
  transitionSec: 0,
  filter: 'none',
  transform: DEFAULT_TRANSFORM,
};

function renderSmartPanel(workspaceProjectId: string | null): string {
  return renderToStaticMarkup(
    createElement(
      StudioProjectProvider,
      { workspaceProjectId } as ComponentProps<typeof StudioProjectProvider>,
      createElement(SmartPanel, { clip, patchClip: () => undefined }),
    ),
  );
}

/** The href of the rendered route card, read back off its own anchor. */
function routeHref(markup: string, routeId: string): string | null {
  const anchor = new RegExp(`<a[^>]*data-testid="smart-${routeId}"[^>]*>`).exec(markup)?.[0];
  if (!anchor) return null;
  return /href="([^"]*)"/.exec(anchor)?.[1] ?? null;
}

describe('SmartPanel Boards hand-off', () => {
  it('carries the active project on every route in project mode', () => {
    const markup = renderSmartPanel('project-1');
    expect(SMART_ROUTES.length).toBeGreaterThan(0);
    for (const route of SMART_ROUTES) {
      expect(routeHref(markup, route.id), route.id).toBe('/boards?projectId=project-1');
    }
  });

  it('stays standalone when there is no project', () => {
    const markup = renderSmartPanel(null);
    for (const route of SMART_ROUTES) {
      expect(routeHref(markup, route.id), route.id).toBe('/boards');
    }
  });

  it('escapes a project id that would otherwise break the query', () => {
    const markup = renderSmartPanel('project a/b');
    expect(routeHref(markup, SMART_ROUTES[0]!.id)).toBe('/boards?projectId=project+a%2Fb');
  });
});
