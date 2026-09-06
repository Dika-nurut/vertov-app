import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { clusterKeyFor } from '@seed/credits';

/** The first-party device signal used by the existing anti-farm cluster policy. */
export const DEVICE_COOKIE = 'seed_did';
const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

/**
 * Read the long-lived device id, minting it when the request is the first API
 * touch. The raw id never leaves the cookie; callers should persist only the
 * derived cluster key.
 */
export function resolveDeviceId(req: FastifyRequest, reply: FastifyReply): string {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === DEVICE_COOKIE && value.length) return decodeURIComponent(value.join('='));
  }
  const id = randomUUID();
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  reply.header(
    'set-cookie',
    `${DEVICE_COOKIE}=${id}; Path=/; Max-Age=${DEVICE_COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax${secure}`,
  );
  return id;
}

/** Hash(device cookie + network prefix); no raw IP/device value is persisted. */
export function resolveDeviceCluster(req: FastifyRequest, reply: FastifyReply): string {
  return clusterKeyFor(resolveDeviceId(req, reply), req.ip);
}
