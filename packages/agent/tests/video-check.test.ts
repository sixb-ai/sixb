import { describe, expect, test } from "bun:test"
import type { VideoOutline } from "@sixb/core/artifacts"
import {
  craftWarnings,
  videoInstants,
  videoWarnings,
} from "../src/artifacts/layout-check/video-check"

// What a video's check snapshots and reports, from HyperFrames' findings. The check itself runs
// HyperFrames in the agent image (video.cjs); these hold what the Agent is told of it.

function outline(lengths: readonly number[]): VideoOutline {
  let startMs = 0
  return {
    kind: "video",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: lengths.reduce((sum, each) => sum + each, 0),
    scenes: lengths.map((durationMs, index) => {
      const scene = { id: `s${index + 1}`, startMs, durationMs, renderKey: "" }
      startMs += durationMs
      return scene
    }),
  }
}

describe("a video's check", () => {
  test("snapshots the first frame, then each scene once what comes in has come in, at its middle, and before it cuts", () => {
    expect(videoInstants(outline([4_000, 1_000]))).toEqual([
      { atMs: 0, scene: "s1" },
      { atMs: 400, scene: "s1" },
      { atMs: 2_000, scene: "s1" },
      { atMs: 3_750, scene: "s1" },
      { atMs: 4_150, scene: "s2" },
      { atMs: 4_500, scene: "s2" },
      { atMs: 4_900, scene: "s2" },
    ])
  })

  // Guard proof: drop the MAX_FRAMES branches of videoInstants; a long video then snapshots three
  // frames a scene, and its check takes as long as it is.
  test("snapshots as many frames for a long video as for a teaser", () => {
    const middles = videoInstants(outline(Array.from({ length: 12 }, () => 5_000)))
    expect(middles).toHaveLength(13)
    expect(middles[1]).toEqual({ atMs: 2_500, scene: "s1" })

    const spread = videoInstants(outline(Array.from({ length: 200 }, () => 3_000)))
    expect(spread).toHaveLength(24)
    expect(spread.at(-1)).toEqual({ atMs: 586_957, scene: "s196" })
  })

  test("reports what HyperFrames finds, errors first, by when and in which scene", () => {
    const warnings = videoWarnings(
      [
        { code: "audio_none", severity: "info", message: "The film has no sound." },
        {
          code: "subcomposition_blanks_before_host",
          severity: "warning",
          message: '<div id="s1"> sub-composition ends at 4s.',
        },
        {
          code: "text_below_floor",
          severity: "warning",
          message: "Type floor is 28 px.",
          text: "fine print",
          time: 0.5,
        },
        {
          code: "contrast_aa_failure",
          severity: "error",
          message: "Contrast is 1.49:1; WCAG AA requires 4.5:1.",
          text: "Ship faster",
          time: 4.2,
          fixHint: "Use rgb(124,124,124).",
        },
        {
          code: "missing_timeline_registry",
          severity: "error",
          message: "Missing `window.__timelines` registration.",
          sourceFile: "/workspace/.sixb/agent/checks/art_1-r1/project/scenes/s2.html",
        },
      ],
      outline([4_000, 1_000])
    )

    expect(warnings).toEqual([
      {
        code: "video_missing_timeline_registry",
        message: "In scenes/s2.html: Missing `window.__timelines` registration.",
      },
      {
        code: "video_contrast_aa_failure",
        part: "s2",
        message:
          "At 4.2 s, in scene 's2': Contrast is 1.49:1; WCAG AA requires 4.5:1. (“Ship faster”) Use rgb(124,124,124).",
      },
      {
        code: "video_text_below_floor",
        part: "s1",
        message: "At 0.5 s, in scene 's1': Type floor is 28 px. (“fine print”)",
      },
    ])
  })

  // Guard proof: report the CDN requests as any finding (drop `unreachable` in videoWarnings);
  // the Agent is then told its fonts and GSAP fail to load, and changes a video that works.
  test("tells a sandbox without the CDNs from a video that fails to load them", () => {
    const failed = (url: string) => ({
      code: "request_failed",
      severity: "error" as const,
      message: `Failed to load ${url.split("/").at(-1)}: net::ERR_INTERNET_DISCONNECTED`,
      url,
      time: 0,
    })
    const warnings = videoWarnings(
      [
        failed("https://fonts.googleapis.com/css2?family=Inter+Tight:wght@600&display=block"),
        failed("https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js"),
        {
          code: "request_failed",
          severity: "error",
          message: "Failed to load logo.svg: net::ERR_FILE_NOT_FOUND",
          url: "file:///work/media/logo.svg",
          time: 0,
        },
      ],
      outline([4_000])
    )

    expect(warnings.map((warning) => warning.code)).toEqual([
      "video_cdn_unreachable",
      "video_request_failed",
    ])
    expect(warnings[0]?.message).toStartWith(
      "This sandbox cannot reach fonts.googleapis.com, cdn.jsdelivr.net, so the check ran without the 2 files"
    )
  })

  test("names how many more it found past the first twelve", () => {
    const findings = Array.from({ length: 15 }, (_, index) => ({
      code: "canvas_overflow",
      severity: "warning" as const,
      message: "Text extends outside the composition canvas.",
      time: index * 0.1,
    }))
    const warnings = videoWarnings(findings, outline([4_000]))
    expect(warnings).toHaveLength(13)
    expect(warnings.at(-1)).toEqual({
      code: "video_more",
      message: "3 more findings; run hyperframes check on the video to see every one.",
    })
  })

  // Guard proof: return [] from craftWarnings; a cheap model then reads past an end card that
  // lingers, a blank frame and a scene that flashes by, as the validation teasers did.
  test("measures the guide's craft: blank frames, flashing scenes, a lingering end card, a long teaser", () => {
    const film = outline([3_000, 600, 20_000, 22_000, 6_000])
    const frames = [
      { atMs: 0, scene: "s1", ink: 0.004 },
      { atMs: 1_500, scene: "s1", ink: 0.08 },
      { atMs: 45_800, scene: "s5", ink: 0.006 },
      { atMs: 49_000, scene: "s5" },
    ]

    expect(craftWarnings(film, frames)).toEqual([
      {
        code: "video_empty_frame",
        part: "s1",
        message:
          "At 0 s, in scene 's1': The first frame, the video's thumbnail, is nearly empty. Show the subject from the first frame of each scene: words or the product, never a bare ground or a lone logo.",
      },
      {
        code: "video_empty_frame",
        part: "s5",
        message:
          "At 45.8 s, in scene 's5': The frame is nearly empty. Show the subject from the first frame of each scene: words or the product, never a bare ground or a lone logo.",
      },
      {
        code: "video_scene_short",
        part: "s2",
        message:
          "At 3 s, scene 's2' lasts 0.6 s, too short to be seen: give it a second or more, or fold it into the scene beside it.",
      },
      {
        code: "video_end_card_long",
        part: "s5",
        message:
          "At 45.6 s, the end card, scene 's5', holds 6 s: shorten its host's data-duration to 3 to 4 s, still for the last two.",
      },
      {
        code: "video_long",
        message:
          "It runs 51.6 s, past the 45 s a teaser holds: cut it, unless the user asked for this length or it is not a teaser.",
      },
    ])
    expect(craftWarnings(outline([3_000, 4_000]), [{ atMs: 0, scene: "s1", ink: 0.03 }])).toEqual(
      []
    )
  })
})
