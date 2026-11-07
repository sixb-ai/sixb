import type { BackoffPolicy } from "@sixb/core/internal/workers"

/** 250 ms doubling to 10 s: a broker or a queue that blinks should cost events no real delay. */
export const RETRY_BACKOFF: BackoffPolicy = { initialMs: 250, maxMs: 10_000 }
