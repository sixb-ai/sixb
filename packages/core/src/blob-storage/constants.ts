/**
 * Maximum size, in bytes, of a single-request ("server"-strategy) file upload.
 *
 * This is a single source of truth for two sides that must agree: it is both the
 * server's simple-upload ceiling AND the client's threshold for switching to a
 * staged (direct-put) upload. Keeping one constant prevents the two limits from
 * drifting apart.
 */
export const DEFAULT_SIMPLE_FILE_UPLOAD_BYTES = 25 * 1024 * 1024
