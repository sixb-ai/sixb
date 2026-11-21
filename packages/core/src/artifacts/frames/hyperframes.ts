import runtime from "./generated/hyperframes.txt" with { type: "text" }

/**
 * The HyperFrames release a video plays with in its frame. The agent image's `hyperframes` CLI,
 * which checks and renders videos, is the same release, so what the app plays is what an export
 * renders; a test holds the two together.
 */
export const HYPERFRAMES_VERSION = "0.9.68"

/**
 * HyperFrames' runtime, `hyperframe.runtime.iife.js`, as `bun run generate:hyperframes-runtime`
 * copies it from `@hyperframes/core`: a video's frame serves it as `__sixb/hyperframes.js`.
 */
export const HYPERFRAMES_RUNTIME: string = runtime
