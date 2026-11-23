import { describe, expect, test } from "bun:test"
import type { VideoOutline } from "@sixb/core/artifacts"
import {
  hiddenMediaWarnings,
  type MediaSight,
  mediaInstants,
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
  // Guard proof: sample a scene's start at 15% of its length again; the 1.4 s scene is then
  // snapshotted 0.21 s in, while its caption is still half faded in.
  test("snapshots the first frame, then each scene once what comes in has come in, at its middle, and before it cuts", () => {
    expect(videoInstants(outline([4_000, 1_400, 900]))).toEqual([
      { atMs: 0, scene: "s1" },
      { atMs: 400, scene: "s1" },
      { atMs: 2_000, scene: "s1" },
      { atMs: 3_750, scene: "s1" },
      { atMs: 4_400, scene: "s2" },
      { atMs: 4_700, scene: "s2" },
      { atMs: 5_260, scene: "s2" },
      { atMs: 5_700, scene: "s3" },
      { atMs: 5_850, scene: "s3" },
      { atMs: 6_210, scene: "s3" },
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
          code: "canvas_overflow",
          severity: "warning",
          message: "Text extends outside the composition canvas.",
          text: "fine print",
          time: 0.5,
        },
        {
          code: "media_proxy_failed",
          severity: "error",
          message: "media/demo.mp4 could not be decoded.",
          time: 4.2,
          fixHint: "Re-export it as H.264.",
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
        code: "video_media_proxy_failed",
        part: "s2",
        message:
          "At 4.2 s, in scene 's2': media/demo.mp4 could not be decoded. Re-export it as H.264.",
      },
      {
        code: "video_canvas_overflow",
        part: "s1",
        message:
          "At 0.5 s, in scene 's1': Text extends outside the composition canvas. (“fine print”)",
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

  // Guard proof: drop STYLE_PASSES from videoWarnings; the Agent is then told to enlarge small
  // type and recolor low-contrast text, a style the person and the project choose.
  test("reports no style: neither HyperFrames' contrast nor its craft", () => {
    const style = [
      {
        pass: "craft",
        code: "text_below_floor",
        severity: "warning" as const,
        message: "Type floor is 28 px.",
        text: "fine print",
        time: 0.5,
      },
      {
        pass: "craft",
        code: "first_frame_empty",
        severity: "warning" as const,
        message: "Frame 0 paints nothing but the background.",
        time: 0,
      },
      {
        pass: "contrast",
        code: "contrast_aa_failure",
        severity: "error" as const,
        message: "Contrast is 1.49:1; WCAG AA requires 4.5:1.",
        text: "Ship faster",
        time: 4.2,
      },
    ]
    const broken = {
      pass: "runtime",
      code: "page_error",
      severity: "error" as const,
      message: "gsap is not defined",
      time: 0,
    }

    expect(videoWarnings([...style, broken], outline([4_000, 1_000]))).toEqual([
      {
        code: "video_page_error",
        part: "s1",
        message: "At 0 s, in scene 's1': gsap is not defined",
      },
    ])
  })

  // Guard proof: return [] from hiddenMediaWarnings; the footage of a scene whose fade-in never
  // ran then stays black on every frame of the film, and the check passes it.
  test("names footage that never shows while it plays, by scene, file and instant", () => {
    const film = outline([4_000, 4_000])
    const phone = (scene: string, hidden?: MediaSight["hidden"]): MediaSight => ({
      scene,
      index: 0,
      tag: "video",
      file: "media/phone.mp4",
      start: 0,
      duration: 4,
      ...(hidden ? { hidden } : {}),
    })

    const warnings = hiddenMediaWarnings(film, [
      { time: 0.4, sights: [phone("s1", "opacity")] },
      { time: 2, sights: [phone("s1", "opacity")] },
      { time: 3.75, sights: [phone("s1", "opacity")] },
      // A fade-in: not yet there 0.4 s in, there by the middle.
      { time: 4.4, sights: [phone("s2", "opacity")] },
      { time: 6, sights: [phone("s2")] },
      { time: 7.75, sights: [phone("s2")] },
    ])

    expect(warnings).toEqual([
      {
        code: "video_media_hidden",
        part: "s1",
        message:
          "From 0.4 s to 3.75 s, in scene 's1': the <video> media/phone.mp4 never shows while it plays: its opacity, or a parent's, is 0. Viewers see what is behind it instead. Make sure what brings it in runs within the scene and targets it, or remove it if it is not meant to show.",
      },
    ])
  })

  // Guard proof: judge each medium at every instant of its scene (drop the window test in
  // hiddenMediaWarnings); the clip that plays from 1.5 s to 2.5 s, which HyperFrames hides
  // outside them, then reads as never shown.
  test("judges a clip only while it plays, and not at all when no instant falls in it", () => {
    const film = outline([4_000])
    const clip = (hidden?: MediaSight["hidden"]): MediaSight => ({
      scene: "s1",
      index: 1,
      tag: "img",
      file: "media/shot.png",
      start: 1.5,
      duration: 1,
      ...(hidden ? { hidden } : {}),
    })
    const late = { ...clip("display"), index: 2, start: 3.8, duration: 0.2 }

    expect(
      hiddenMediaWarnings(film, [
        { time: 0.4, sights: [clip("display"), late] },
        { time: 2, sights: [clip(), late] },
        { time: 3.75, sights: [clip("display"), late] },
      ])
    ).toEqual([])
  })

  // Guard proof: return no boxes from hiddenMediaWarnings (skip its `framed` looks); the card
  // whose clip ends at 2 s then stays empty on screen until 6 s, and the check passes it, since
  // the frame keeps its caption and the chapter's index.
  test("names a box left on screen empty once its clip has ended, from when to when", () => {
    const film = outline([6_000])
    const card = (time: number): MediaSight => ({
      scene: "s1",
      index: 0,
      tag: "video",
      file: "media/card.mp4",
      start: 0,
      duration: 2,
      ...(time >= 2 ? { hidden: "visibility" } : {}),
      box: { index: 0 },
    })

    const warnings = hiddenMediaWarnings(
      film,
      [0.4, 1, 2, 3, 4, 5, 5.75].map((time) => ({ time, sights: [card(time)] }))
    )
    expect(warnings).toEqual([
      {
        code: "video_media_box_empty",
        part: "s1",
        message:
          "From 2 s to 5.75 s, in scene 's1': the box that frames the <video> media/card.mp4 is on screen with nothing in it: it stopped playing at 2 s. Viewers see an empty frame. Play it for as long as its box shows, by its data-start and data-duration, or take the box out with it.",
      },
    ])
  })

  // Guard proof: name every medium never shown again (drop `named` in hiddenMediaWarnings); the
  // phone that stays black is then reported twice, once for its box and once for itself.
  test("names a phone that frames footage at opacity 0 once, by its box", () => {
    const film = outline([4_000])
    const phone: MediaSight = {
      scene: "s1",
      index: 0,
      tag: "video",
      file: "media/phone.mp4",
      start: 0,
      hidden: "opacity",
      box: { index: 0 },
    }

    const warnings = hiddenMediaWarnings(
      film,
      [0.4, 1, 2, 3, 3.75].map((time) => ({ time, sights: [phone] }))
    )
    expect(warnings.map((warning) => warning.code)).toEqual(["video_media_box_empty"])
    expect(warnings[0]?.message).toContain(
      "From 0.4 s to 3.75 s, in scene 's1': the box that frames the <video> media/phone.mp4 is on screen with nothing in it: its opacity, or a parent's, is 0."
    )
  })

  // Guard proof: judge a box by its first medium alone, or at a single look (`run.length >= 1`
  // in emptyRun); the frame whose second clip follows the first, or the card whose clip ends a
  // frame before it leaves, then reads as empty.
  test("leaves alone a box that a second clip fills, one that leaves with its clip, or one hidden", () => {
    const film = outline([6_000])
    const shot = (index: number, start: number, time: number, box = {}): MediaSight => ({
      scene: "s1",
      index,
      tag: "video",
      file: `media/shot-${index}.mp4`,
      start,
      duration: 3,
      ...(time < start || time >= start + 3 ? { hidden: "visibility" } : {}),
      box: { index: 0, ...box },
    })
    const times = [0.4, 1, 2, 3, 4, 5, 5.75]

    // Two clips in a row in the same frame.
    expect(
      hiddenMediaWarnings(
        film,
        times.map((time) => ({ time, sights: [shot(0, 0, time), shot(1, 3, time)] }))
      )
    ).toEqual([])
    // A clip that ends at 3 s, seen empty once before its box fades out.
    expect(
      hiddenMediaWarnings(
        film,
        times.map((time) => ({
          time,
          sights: [shot(0, 0, time, time > 3 ? { hidden: "opacity" } : {})],
        }))
      )
    ).toEqual([])
  })

  // Guard proof: look only at the snapshot's instants (return the frames' alone from
  // mediaInstants); a card left empty between a scene's middle and its end then goes unseen.
  test("looks at the media every second between snapshots, and as often for a long video", () => {
    const short = outline([4_000])
    expect(mediaInstants(short, videoInstants(short))).toEqual([0, 400, 1_000, 2_000, 3_000, 3_750])

    const long = outline(Array.from({ length: 60 }, () => 10_000))
    const looks = mediaInstants(long, videoInstants(long))
    expect(looks.length).toBeLessThanOrEqual(240 + 24)
    expect(looks[1]).toBe(2_500)
  })
})
