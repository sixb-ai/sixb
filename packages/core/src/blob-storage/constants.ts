/**
 * Maximum size, in bytes, of a simple upload: one `POST /api/files` request.
 *
 * This is a single source of truth for two sides that must agree: it is both the
 * server's simple-upload ceiling AND the client's threshold for switching to a
 * staged upload. Keeping one constant prevents the two limits from drifting apart.
 * A staged upload declared without a size is held to it too.
 */
export const DEFAULT_SIMPLE_FILE_UPLOAD_BYTES = 25 * 1024 * 1024

/**
 * The most one staged upload may hold. Its bytes go to blob storage as they arrive, or straight to
 * the provider, never whole in the server's memory. A file artifact's one file may be this large.
 */
export const MAX_FILE_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
