import { describe, expect, it } from 'vitest';
import { serializeJsonLd } from './json-ld';

describe('serializeJsonLd', () => {
  it('keeps valid JSON while escaping script-closing input', () => {
    const serialized = serializeJsonLd({ name: '</script><script>alert(1)</script>' });
    expect(serialized).not.toContain('<');
    expect(JSON.parse(serialized)).toEqual({ name: '</script><script>alert(1)</script>' });
  });
});
