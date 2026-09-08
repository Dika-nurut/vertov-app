import { Transform, type Readable } from 'node:stream';
import type { FastifyRequest } from 'fastify';

function requestTooLargeError(): Error & { code: string; statusCode: number } {
  return Object.assign(new Error('multipart request too large'), {
    code: 'FST_REQ_FILE_TOO_LARGE',
    statusCode: 413,
  });
}

/**
 * @fastify/multipart pipes req.raw directly, so Fastify's returned preParsing
 * payload is not enough to cap chunked multipart requests. Feed raw through a
 * byte-counting stream and temporarily route multipart's raw.pipe through it.
 */
export function limitMultipartPayload(
  request: FastifyRequest,
  payload: Readable,
  maxBytes: number,
): Readable {
  const header = request.headers['content-length'];
  const contentLength = typeof header === 'string' ? Number(header) : Number.NaN;
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    throw requestTooLargeError();
  }

  const raw = request.raw as unknown as Readable;
  const originalRawPipe = raw.pipe;
  const sourcePipe = payload.pipe.bind(payload);
  let received = 0;
  const limitedPayload = new Transform({
    transform(chunk: Buffer | string | Uint8Array, encoding, callback) {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk.length
        : typeof chunk === 'string'
          ? Buffer.byteLength(chunk, encoding)
          : chunk.byteLength;
      received += bytes;
      if (received > maxBytes) {
        callback(requestTooLargeError());
        return;
      }
      callback(null, chunk);
    },
  });
  const guardedRawPipe = ((destination: NodeJS.WritableStream, options?: { end?: boolean }) =>
    limitedPayload.pipe(destination, options)) as typeof raw.pipe;

  raw.pipe = guardedRawPipe;
  limitedPayload.once('close', () => {
    if (raw.pipe === guardedRawPipe) raw.pipe = originalRawPipe;
  });
  limitedPayload.once('error', (error) => {
    if (!payload.destroyed) payload.destroy(error);
  });
  sourcePipe(limitedPayload);
  return limitedPayload;
}
