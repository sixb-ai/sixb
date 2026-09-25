/**
 * A function typed to return `SixbHost` can build one.
 *
 * Returning `new SixbHost(options)` there makes TypeScript infer `TParams` against the declared
 * return type. Without a declared variance it measures `TParams` by probing the whole bound SDK,
 * which overflows (TS2589). Guard: drop `in out` from `SixbHost` in runtime/host.ts and
 * `bun run typecheck:tests` fails with TS2589 — here or at the first test helper written the same
 * way (reproduced with TypeScript 5.9.3).
 */
import { SixbHost, type SixbHostOptions } from "../src"

export function createHost(options: SixbHostOptions): SixbHost {
  return new SixbHost(options)
}
