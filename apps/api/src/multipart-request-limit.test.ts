import { Readable, Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import type { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { limitMultipartPayload } from './multipart-request-limit';

function requestFor(raw: Readable, contentLength?: string): FastifyRequest {
  return {
    raw,
    headers: contentLength === undefined ? {} : { 'content-length': contentLength },
  } as unknown as FastifyRequest;
}

describe('limitMultipartPayload', () => {
  it('rejects a declared request larger than the aggregate cap', () => {
    const raw = Readable.from([Buffer.from('too large')]);
    expect(() => limitMultipartPayload(requestFor(raw, '9'), raw, 8)).toThrow(
      'multipart request too large',
    );
  });

  it('counts chunked bytes without buffering the full request', async () => {
    const raw = Readable.from([Buffer.from('12345'), Buffer.from('67890')]);
    (raw as unknown as EventEmitter).on('error', () => {});
    const limited = limitMultipartPayload(requestFor(raw), raw, 9);
    const sink = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    const completed = finished(limited);
    raw.pipe(sink);

    await expect(completed).rejects.toThrow('multipart request too large');
    expect(raw.destroyed).toBe(true);
  });

  it('passes requests within the cap through the raw pipe used by multipart', async () => {
    const raw = Readable.from([Buffer.from('12345'), Buffer.from('67890')]);
    const limited = limitMultipartPayload(requestFor(raw), raw, 10);
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const completed = finished(sink);
    raw.pipe(sink);

    await completed;
    expect(Buffer.concat(chunks).toString()).toBe('1234567890');
    expect(limited.destroyed).toBe(true);
  });
});
