/** How long the render worker gives one PDF, how many times it tries, and how long it waits between. */
export const DOCUMENT_PDF_JOB = {
  timeoutMs: 2 * 60_000,
  attempts: 2,
  backoffMs: 15_000,
} as const

/** How long a PDF asked for is worth waiting for: every attempt, and the waits between them. */
export const DOCUMENT_PDF_WAIT_MS =
  DOCUMENT_PDF_JOB.attempts * DOCUMENT_PDF_JOB.timeoutMs +
  (DOCUMENT_PDF_JOB.attempts - 1) * DOCUMENT_PDF_JOB.backoffMs
