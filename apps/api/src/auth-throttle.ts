import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type IORedis from 'ioredis';
import { checkRateLimit } from './rate-limit';
import { isDisposableEmail } from '@seed/credits';

/**
 * Abuse throttles on the unauthenticated auth front door.
 *
 * - BL-6: magic-link email-bombing. The Fastify per-IP limit (5/15min) is
 *   trivially defeated by rotating IPs, letting an attacker flood ANY victim
 *   inbox. We add a per-DESTINATION-EMAIL Redis throttle, independent of IP.
 * - BL-3: anonymous-signup credit farming. `/sign-in/anonymous` only had the
 *   global 100/min bucket; a script could mint unlimited free-credit accounts.
 *   We add a tight per-client-IP throttle (the IP is now the real caller — see
 *   BL-7 trustProxy).
 *
 * The `forward` dependency performs the real Better-Auth handling; injecting it
 * keeps these routes unit-testable without standing up Better-Auth or a DB.
 */
export interface AuthThrottleDeps {
  redis: IORedis;
  forward: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Override the prod detection (tests pass `true` to exercise the tight caps). */
  isProd?: boolean;
}

// Production ceilings. Non-prod uses a very high cap so local/e2e never trips.
const MAGIC_LINK_PER_EMAIL_MAX = 4; // per 15 min, per destination address
const MAGIC_LINK_WINDOW_SECONDS = 15 * 60;
const ANON_SIGNUP_PER_IP_MAX = 10; // per hour, per client IP
const ANON_SIGNUP_WINDOW_SECONDS = 60 * 60;
// Phone OTP costs real money per flash-call/SMS, so cap it tightly on both axes:
// per destination number (anti-bombing) and per client IP (anti-farming).
const PHONE_OTP_PER_PHONE_MAX = 3; // per 15 min, per destination number
const PHONE_OTP_PER_PHONE_WINDOW_SECONDS = 15 * 60;
const PHONE_OTP_PER_IP_MAX = 10; // per hour, per client IP
const PHONE_OTP_PER_IP_WINDOW_SECONDS = 60 * 60;
const LIFTED = 1_000_000; // effectively unlimited (non-prod)

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const e = raw.trim().toLowerCase();
  return e.length > 0 && e.length <= 320 ? e : null;
}

function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.replace(/[^\d+]/g, '');
  return p.length >= 8 && p.length <= 20 ? p : null;
}

export function setupAuthFrontDoorRoutes(app: FastifyInstance, deps: AuthThrottleDeps): void {
  const isProd = deps.isProd ?? process.env.NODE_ENV === 'production';
  const emailMax = isProd ? MAGIC_LINK_PER_EMAIL_MAX : LIFTED;
  const ipMax = isProd ? ANON_SIGNUP_PER_IP_MAX : LIFTED;

  // Magic-link: keep the existing per-IP Fastify limit AND add per-email.
  app.post('/api/auth/sign-in/magic-link', {
    config: {
      rateLimit: {
        max: isProd ? 5 : 1000,
        timeWindow: '15 minutes',
      },
    },
    handler: async (req, reply) => {
      const email = normalizeEmail((req.body as { email?: unknown } | undefined)?.email);
      if (email && isDisposableEmail(email)) {
        return reply.status(400).send({ error: 'disposable_email' });
      }
      if (email) {
        const rl = await checkRateLimit(
          deps.redis,
          `seed:maglink:email:${email}`,
          emailMax,
          MAGIC_LINK_WINDOW_SECONDS,
        );
        if (!rl.allowed) return reply.status(429).send({ error: 'rate_limit_exceeded' });
      }
      return deps.forward(req, reply);
    },
  });

  const rejectDisposableEmail = async (req: FastifyRequest, reply: FastifyReply) => {
    const email = normalizeEmail((req.body as { email?: unknown } | undefined)?.email);
    if (email && isDisposableEmail(email)) {
      return reply.status(400).send({ error: 'disposable_email' });
    }
    return deps.forward(req, reply);
  };

  // Email OTP has two Better-Auth endpoints and otherwise rides the wildcard
  // bridge, so put the same signup policy in front of both.
  app.post('/api/auth/email-otp/send-verification-otp', rejectDisposableEmail);
  app.post('/api/auth/sign-in/email-otp', rejectDisposableEmail);

  // Anonymous signup: tight per-IP throttle (credit-farm defense).
  app.post('/api/auth/sign-in/anonymous', async (req, reply) => {
    const rl = await checkRateLimit(
      deps.redis,
      `seed:anon-signup:ip:${req.ip}`,
      ipMax,
      ANON_SIGNUP_WINDOW_SECONDS,
    );
    if (!rl.allowed) return reply.status(429).send({ error: 'rate_limit_exceeded' });
    return deps.forward(req, reply);
  });

  // Phone OTP: cap per client IP AND per destination number (each send bills us).
  const phonePerPhoneMax = isProd ? PHONE_OTP_PER_PHONE_MAX : LIFTED;
  const phonePerIpMax = isProd ? PHONE_OTP_PER_IP_MAX : LIFTED;
  app.post('/api/auth/phone-number/send-otp', {
    config: { rateLimit: { max: isProd ? 5 : 1000, timeWindow: '15 minutes' } },
    handler: async (req, reply) => {
      const ipRl = await checkRateLimit(
        deps.redis,
        `seed:phoneotp:ip:${req.ip}`,
        phonePerIpMax,
        PHONE_OTP_PER_IP_WINDOW_SECONDS,
      );
      if (!ipRl.allowed) return reply.status(429).send({ error: 'rate_limit_exceeded' });
      const phone = normalizePhone(
        (req.body as { phoneNumber?: unknown } | undefined)?.phoneNumber,
      );
      if (phone) {
        const phoneRl = await checkRateLimit(
          deps.redis,
          `seed:phoneotp:phone:${phone}`,
          phonePerPhoneMax,
          PHONE_OTP_PER_PHONE_WINDOW_SECONDS,
        );
        if (!phoneRl.allowed) return reply.status(429).send({ error: 'rate_limit_exceeded' });
      }
      return deps.forward(req, reply);
    },
  });
}
