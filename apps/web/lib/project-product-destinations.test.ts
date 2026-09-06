import { describe, expect, it } from 'vitest';
import {
  PROJECT_PRODUCT_DESTINATIONS,
  projectDocumentHref,
  projectResolverHref,
} from './project-product-destinations';

describe('project product destinations', () => {
  it('keeps the five project products in one map and scopes every destination', () => {
    expect(Object.keys(PROJECT_PRODUCT_DESTINATIONS)).toEqual([
      'scenario',
      'boards',
      'studio',
      'generate',
      'gallery',
    ]);
    expect(projectResolverHref('boards', 'project/a')).toBe(
      '/workspace/resolve/boards?projectId=project%2Fa',
    );
    expect(projectDocumentHref('scenario', 'script/a', 'project/a')).toBe(
      '/scenario/script%2Fa?projectId=project%2Fa',
    );
  });
});
