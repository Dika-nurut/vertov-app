import { describe, expect, it } from 'vitest';
import { encodeResumeToken, parseResumeToken } from './resume-token';

describe('resume-token — composite provider handle format', () => {
  it('encodes gateway + id as `gateway::id`', () => {
    expect(encodeResumeToken('evolink', 'abc123')).toBe('evolink::abc123');
  });

  it('round-trips a composite value', () => {
    const stored = encodeResumeToken('openrouter', 'vid_9f2');
    expect(parseResumeToken(stored)).toEqual({ gateway: 'openrouter', providerJobId: 'vid_9f2' });
  });

  it('parses a gateway with a hyphen (e.g. a future `gemini-omni` key)', () => {
    expect(parseResumeToken('gemini-omni::task-1')).toEqual({
      gateway: 'gemini-omni',
      providerJobId: 'task-1',
    });
  });

  it('the id may itself contain colons — only the FIRST `::` is the delimiter', () => {
    // The gateway key can't contain a colon, so `atlascloud::pred::99` binds to
    // `atlascloud` with id `pred::99`, not the other way around.
    expect(parseResumeToken('atlascloud::pred::99')).toEqual({
      gateway: 'atlascloud',
      providerJobId: 'pred::99',
    });
  });

  it('returns null for a legacy bare id (no gateway prefix)', () => {
    expect(parseResumeToken('abc123')).toBeNull();
  });

  it('returns null for a kie batch id (single colon, not a resume token)', () => {
    // kie encodes batches as `kie-batch:id1,id2` — a single colon, so it must
    // NOT be mistaken for a `gateway::id` composite.
    expect(parseResumeToken('kie-batch:t1,t2')).toBeNull();
  });

  it('returns null when the gateway segment is empty', () => {
    expect(parseResumeToken('::abc123')).toBeNull();
  });

  it('returns null when the id segment is empty', () => {
    expect(parseResumeToken('evolink::')).toBeNull();
  });
});
