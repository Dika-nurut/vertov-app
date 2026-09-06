import { describe, expect, it } from 'vitest';
import { workflowImageControls, type WorkflowSpec } from '../src/types';

const spec = (params: Record<string, unknown>): WorkflowSpec => ({
  modelId: 'seedance-2-0',
  providerModelId: 'seedance-2.0',
  providerEndpoint: '/videos',
  kind: 'image',
  prompt: 'test',
  params,
  referenceAssets: [],
});

describe('workflowImageControls — rendered resolution precedence', () => {
  it('renders resolution first when a request also carries a cheaper quality alias', () => {
    expect(workflowImageControls(spec({ quality: '1K', resolution: '2K' })).resolution).toBe('2K');
  });
});

describe('workflowImageControls — count ceils to match billing (billed==served)', () => {
  it('serves ceil(n) so a fractional crafted n never delivers fewer than billed', () => {
    // unitsForGenerationModel bills ceil(n); the serializer must serve the same.
    expect(workflowImageControls(spec({ n: 1.4 })).count).toBe(2);
    expect(workflowImageControls(spec({ n: 2.1 })).count).toBe(3);
  });

  it('is unchanged for integer counts (all real UI traffic) and floors at 1', () => {
    expect(workflowImageControls(spec({ n: 3 })).count).toBe(3);
    expect(workflowImageControls(spec({ n: 0 })).count).toBe(1);
    expect(workflowImageControls(spec({})).count).toBe(1);
  });
});
