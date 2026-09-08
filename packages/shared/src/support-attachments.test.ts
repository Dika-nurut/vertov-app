import { describe, expect, it } from 'vitest';
import { isSafeSupportAttachmentFilename, isSafeSupportAttachmentKey } from './support-attachments';

describe('support attachment queue contract', () => {
  it('accepts request ids containing a single dot', () => {
    expect(isSafeSupportAttachmentKey('support/request.id/file_1')).toBe(true);
  });

  it('rejects traversal and foreign object keys', () => {
    expect(isSafeSupportAttachmentKey('support/../escape')).toBe(false);
    expect(isSafeSupportAttachmentKey('seed-assets/request/file_1')).toBe(false);
    expect(isSafeSupportAttachmentKey('support/request/file.name')).toBe(false);
  });

  it('rejects path separators and control characters in mail filenames', () => {
    expect(isSafeSupportAttachmentFilename('error.png')).toBe(true);
    expect(isSafeSupportAttachmentFilename('nested/error.png')).toBe(false);
    expect(isSafeSupportAttachmentFilename('error\n.png')).toBe(false);
  });
});
