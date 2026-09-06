/** Canonical project-asset upload ceiling shared by preflight, route, and parser. */
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024;

/** Fastify content parsers impose their own ceiling before route bodyLimit. */
export const OCTET_STREAM_BODY_LIMIT = UPLOAD_MAX_BYTES;

export const OCTET_STREAM_PARSER_OPTIONS = {
  parseAs: 'buffer' as const,
  bodyLimit: OCTET_STREAM_BODY_LIMIT,
};
