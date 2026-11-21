import { describe, expect, test } from "bun:test"
import type { ArtifactFile } from "../src"
import { ArtifactRequestError, SixbHost } from "../src"
import { placeVideoComment, quoteArtifactComment } from "../src/artifacts"
import { parseArtifactAddress } from "../src/artifacts/address"
import { ARTIFACT_LIMITS } from "../src/artifacts/limits"
import type { VideoOutline } from "../src/artifacts/outline"
import { resolveArtifactAddress } from "../src/artifacts/resolve"
import {
  readVideoComposition,
  videoFilePath,
  videoFilesPlayed,
} from "../src/artifacts/video/composition"
import { emptyGrantIndex } from "../src/authorization/types"
import { inferFileMediaType } from "../src/blob-storage/internal"
import type { ArtifactCommentAnchor } from "../src/storage"
import { createTestSixb } from "../src/testing"
import { createTestRuntimeDeps } from "./test-runtime-deps"

// A video is a HyperFrames project: index.html hosts a <template> file per scene, and each scene
// plays the media beside it. The starts below were checked against `hyperframes timeline --json`
// (HyperFrames 0.9.68, the agent image's): the model reads them as HyperFrames does.

const scene = (id: string, body = `<h1>${id}</h1>`) =>
  `<template>\n  <div data-composition-id="${id}" data-width="1920" data-height="1080">${body}</div>\n</template>\n`

const host = (id: string, start: string, duration: string, extra = "") =>
  `<div id="${id}" data-composition-id="${id}" data-composition-src="scenes/${id}.html" data-start="${start}" data-duration="${duration}"${extra}></div>`

const index = (hosts: readonly string[], root = 'data-width="1920" data-height="1080"') =>
  `<!doctype html>\n<html><body>\n<div data-composition-id="main" ${root}>\n${hosts.join("\n")}\n</div>\n</body></html>\n`

const MUSIC = '<audio id="music" src="media/music.m4a" data-start="0" data-duration="7"></audio>'

/**
 * A launch film: a title, a demo over a clip, and an outro half a second after it, over music the
 * root plays, so the root says how long the video is.
 */
const LAUNCH: Readonly<Record<string, string>> = {
  "index.html": index(
    [
      host("intro", "0", "2", ' data-label="Opening"'),
      host("demo", "intro", "3"),
      host("outro", "demo + 0.5", "1.5", ' data-label="Thanks"'),
      MUSIC,
    ],
    'data-width="1920" data-height="1080" data-duration="7"'
  ),
  "scenes/intro.html": scene("intro"),
  "scenes/demo.html": scene("demo", '<video src="media/clip.mp4" muted playsinline></video>'),
  "scenes/outro.html": scene("outro", '<img src="media/logo.png" alt="Logo">'),
  "styles.css": "h1 { font: 600 120px system-ui; }",
  "media/clip.mp4": "clip",
  "media/music.m4a": "music",
  "media/logo.png": "logo",
}

const read = (files: Readonly<Record<string, string>>) => {
  const { "index.html": root = "", ...rest } = files
  return readVideoComposition(root, (path) => rest[path])
}

const composed = (files: Readonly<Record<string, string>>) => {
  const result = read(files)
  if ("error" in result) throw new Error(result.error)
  return result.composition
}

describe("a video's composition", () => {
  test("resolves each scene's start as HyperFrames does", () => {
    // Listed out of order, a hyphenated id, a negative offset, and an offset written `.25`.
    const composition = composed({
      "index.html": index(
        [
          host("outro", "body-2 - 1.5", "3"),
          host("intro", "0.5", "2.25", ' data-label="  Cold   open "'),
          host("body-2", "intro + .25", "4"),
        ],
        'data-width="1280" data-height="720" data-fps="25"'
      ),
      "scenes/intro.html": scene("intro"),
      "scenes/body-2.html": scene("body-2"),
      "scenes/outro.html": scene("outro"),
    })

    expect(composition).toMatchObject({ width: 1280, height: 720, fps: 25, durationMs: 8500 })
    expect(
      composition.scenes.map(({ id, label, start, startMs, durationMs }) => ({
        id,
        label,
        start,
        startMs,
        durationMs,
      }))
    ).toEqual([
      {
        id: "intro",
        label: "Cold open",
        start: { type: "at", seconds: 0.5 },
        startMs: 500,
        durationMs: 2250,
      },
      {
        id: "body-2",
        label: undefined,
        start: { type: "after", scene: "intro", offset: 0.25 },
        startMs: 3000,
        durationMs: 4000,
      },
      {
        id: "outro",
        label: undefined,
        start: { type: "after", scene: "body-2", offset: -1.5 },
        startMs: 5500,
        durationMs: 3000,
      },
    ])
  })

  test("reads `intro-2` as a scene's name and `intro - 2` as two seconds before intro ends", () => {
    const starts = (start: string) =>
      composed({
        "index.html": index([
          host("intro", "0", "5"),
          host("intro-2", "1", "1"),
          host("x", start, "1"),
        ]),
        "scenes/intro.html": scene("intro"),
        "scenes/intro-2.html": scene("intro-2"),
        "scenes/x.html": scene("x"),
      }).scenes.find((each) => each.id === "x")?.startMs

    expect(starts("intro-2")).toBe(2000)
    expect(starts("intro - 2")).toBe(3000)
    expect(starts("intro-2 + 1")).toBe(3000)
  })

  // Removal proof: drop the host ids from resolveStarts' names, and the outro starts after no scene.
  test("finds a scene by its host's own id, as HyperFrames' templates write it", () => {
    const layer = (id: string, start: string, duration: string) =>
      host(id, start, duration).replace(`id="${id}"`, `id="${id}-layer"`)
    const composition = composed({
      "index.html": index([layer("intro", "0", "2"), layer("outro", "intro-layer + 1", "2")]),
      "scenes/intro.html": scene("intro"),
      "scenes/outro.html": scene("outro"),
    })

    expect(composition.scenes.map(({ id, hostId, startMs }) => ({ id, hostId, startMs }))).toEqual([
      { id: "intro", hostId: "intro-layer", startMs: 0 },
      { id: "outro", hostId: "outro-layer", startMs: 3000 },
    ])
  })

  // Removal proof: let playsOnItsOwn return false, and only the plain root reads as still; let it
  // count a sound, and the soundtrack reads as moving.
  test("says when the root plays or animates something of its own", () => {
    const timeline = (extra: string, root = 'data-width="1920" data-height="1080"') =>
      composed({
        "index.html": index([host("intro", "0", "2"), extra], root),
        "scenes/intro.html": scene("intro"),
      }).rootTimeline

    expect(timeline("")).toBe(false)
    expect(timeline("<style>h1 { color: red; }</style>")).toBe(false)
    expect(
      timeline('<div class="logo"></div>', 'data-width="1920" data-height="1080" data-start="0"')
    ).toBe(false)

    // A library, or a stylesheet, is read with the version's files: see the publishing tests.
    expect(
      timeline('<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>')
    ).toBe(false)
    expect(timeline('<link rel="stylesheet" href="styles.css">')).toBe(false)

    expect(timeline("<style>@keyframes grain { to { opacity: 0 } }</style>")).toBe(true)
    expect(timeline("<script>window.__timelines = {}</script>")).toBe(true)
    expect(timeline('<div style="transition: opacity 1s"></div>')).toBe(true)
    expect(
      timeline(
        '<video src="media/clip.mp4"></video>',
        'data-width="1920" data-height="1080" data-duration="2"'
      )
    ).toBe(true)

    // A soundtrack is heard, never seen: the export mixes it apart from the scenes' frames.
    expect(timeline(MUSIC, 'data-width="1920" data-height="1080" data-duration="2"')).toBe(false)
  })

  test("plays at 30 frames a second, for as long as its scenes, or its root's own length", () => {
    const root = LAUNCH["index.html"] ?? ""
    const silent = root.replace(MUSIC, "").replace(' data-duration="7"', "")
    expect(composed({ ...LAUNCH, "index.html": silent })).toMatchObject({
      fps: 30,
      durationMs: 7000,
    })

    const longer = root.replace('data-duration="7">', 'data-duration="9">')
    expect(composed({ ...LAUNCH, "index.html": longer }).durationMs).toBe(9000)
  })

  test("shows the instant its root's data-poster names before it plays, within its length", () => {
    const root = LAUNCH["index.html"] ?? ""
    const poster = (value: string) =>
      read({
        ...LAUNCH,
        "index.html": root.replace(
          'data-duration="7">',
          `data-duration="7" data-poster="${value}">`
        ),
      })

    expect(composed(LAUNCH).posterMs).toBeUndefined()
    expect(poster("2.4")).toMatchObject({ composition: { posterMs: 2400 } })
    expect(poster("0")).toMatchObject({ composition: { posterMs: 0 } })
    for (const outside of ["7", "-1", "soon"]) {
      expect(poster(outside)).toEqual({
        error: expect.stringContaining(
          `the root composition's data-poster is the instant that shows the video before it plays, in seconds from 0 up to its length of 7 s, such as 2.5; it is "${outside}".`
        ),
      })
    }
  })

  test("lists what each scene and the root play, where each is written", () => {
    const composition = composed(LAUNCH)
    const root = LAUNCH["index.html"] ?? ""
    const demo = composition.scenes.find((each) => each.id === "demo")

    expect(
      composition.media.map(({ element, attribute, value }) => [element, attribute, value])
    ).toEqual([["audio", "src", "media/music.m4a"]])
    expect(demo?.media.map(({ element, value }) => [element, value])).toEqual([
      ["video", "media/clip.mp4"],
    ])

    // Where an editor patches an attribute in place.
    const music = composition.media[0]
    expect(music && root.slice(music.at.start, music.at.end)).toBe('src="media/music.m4a"')
    const start = demo?.host.attributes["data-start"]
    expect(start && root.slice(start.start, start.end)).toBe('data-start="intro"')
    expect(demo && root.slice(demo.host.tag.start, demo.host.tag.end)).toStartWith('<div id="demo"')
    const clip = demo?.media[0]
    expect(clip && LAUNCH["scenes/demo.html"]?.slice(clip.at.start, clip.at.end)).toBe(
      'src="media/clip.mp4"'
    )
  })

  const withHosts = (hosts: readonly string[], scenes: Record<string, string> = {}) => ({
    "index.html": index(hosts),
    "scenes/intro.html": scene("intro"),
    "scenes/demo.html": scene("demo"),
    ...scenes,
  })
  const intro = host("intro", "0", "2")
  const intro4 = host("intro", "0", "4")

  test.each([
    ["no root", { "index.html": "<main></main>" }, "index.html: it has no root composition"],
    [
      "an odd width",
      { "index.html": index([intro], 'data-width="1921" data-height="1080"') },
      "even numbers up to 3840",
    ],
    [
      "a width past 4K",
      { "index.html": index([intro], 'data-width="4096" data-height="2160"') },
      "even numbers up to 3840",
    ],
    [
      "an fps HyperFrames' segments do not take",
      { "index.html": index([intro], 'data-width="1920" data-height="1080" data-fps="29.97"') },
      'data-fps is 24, 25, 30, 60 frames a second, or 30 without one; it is "29.97"',
    ],
    [
      "a size HyperFrames reads otherwise",
      { "index.html": index([intro], 'data-width="1e3" data-height="1080"') },
      "even numbers up to 3840",
    ],
    [
      "an fps HyperFrames does not read",
      { "index.html": index([intro], 'data-width="1920" data-height="1080" data-fps="30.0"') },
      'data-fps is 24, 25, 30, 60 frames a second, or 30 without one; it is "30.0"',
    ],
    ["no scene", { "index.html": index(["<h1>Hi</h1>"]) }, "its root composition hosts no scene"],
    // Removal proof: drop ownTimeline's check in videoLength, and HyperFrames plays these videos
    // for 2 seconds of music, or 10 of a caption, while the outline says 2.
    [
      "a soundtrack without the root's length",
      withHosts([intro, '<audio src="media/music.m4a"></audio>']),
      "<audio> plays on the root composition's own timeline",
    ],
    [
      "a timed element without the root's length",
      withHosts([intro, '<div><p id="caption" data-start="1" data-duration="9">Hi</p></div>']),
      '<p id="caption"> plays on the root composition\'s own timeline',
    ],
    [
      "a host inside another composition",
      withHosts([`<div data-composition-id="layer">${intro}</div>`]),
      "scene 'intro' sits inside composition 'layer'",
    ],
    [
      "an id that reads as a number",
      withHosts([host("1", "0", "2").replace('id="1"', "")]),
      "scene '1' needs a data-composition-id that starts with a letter",
    ],
    ["two scenes of one id", withHosts([intro, intro]), "two scenes are 'intro'"],
    [
      "two hosts of one id",
      withHosts([
        intro.replace('id="intro"', 'id="layer"'),
        host("demo", "0", "2").replace('id="demo"', 'id="layer"'),
      ]),
      'two scene hosts have id "layer"',
    ],
    [
      "a host's id that is another scene's",
      withHosts([
        intro.replace('id="intro"', 'id="demo"'),
        host("demo", "0", "2").replace('id="demo" ', ""),
      ]),
      `scene 'intro''s host has id "demo", which is scene 'demo''s id`,
    ],
    [
      "another element of a scene's id",
      withHosts([intro.replace('id="intro" ', ""), '<p id="intro">Hi</p>']),
      `<p id="intro"> takes the name of a scene`,
    ],
    [
      "another element of a host's id",
      withHosts([intro.replace('id="intro"', 'id="opening"'), '<p id="opening">Hi</p>']),
      `<p id="opening"> takes the name of a scene`,
    ],
    [
      "a file outside the project",
      withHosts([intro.replace("scenes/intro.html", "../intro.html")]),
      "scene 'intro': data-composition-src names its file inside the project",
    ],
    [
      "no start",
      withHosts([intro.replace('data-start="0" ', "")]),
      "scene 'intro' needs data-start",
    ],
    [
      "a start it cannot read",
      withHosts([intro, host("demo", "intro +", "2")]),
      "scene 'demo' needs data-start",
    ],
    [
      "no length",
      withHosts([intro.replace(' data-duration="2"', "")]),
      `scene 'intro''s data-duration is its length in seconds, such as 4 or 2.5; it is ""`,
    ],
    [
      "a length shorter than a millisecond",
      withHosts([host("intro", "0", "0.0001")]),
      `scene 'intro''s data-duration is its length in seconds, such as 4 or 2.5; it is "0.0001"`,
    ],
    [
      "a start after no scene",
      withHosts([intro, host("demo", "intor", "2")]),
      "scene 'demo' starts after 'intor', which is no scene; its scenes are 'intro'",
    ],
    [
      "starts that go round",
      withHosts([host("intro", "demo", "2"), host("demo", "intro + 1", "2")]),
      "scenes 'intro', 'demo' each start after another of them, so none starts",
    ],
    [
      "a scene that starts after itself",
      withHosts([host("intro", "intro + 1", "2")]),
      "scene 'intro' starts after itself, so it never starts",
    ],
    [
      "a start before the video",
      withHosts([intro, host("demo", "intro - 5", "2")]),
      "scene 'demo' starts at -3 s: a scene starts at 0 or later",
    ],
    ["a negative start", withHosts([host("intro", "-1", "2")]), "scene 'intro' starts at -1 s"],
    [
      "a scene past the root's length",
      {
        ...withHosts([intro]),
        "index.html": index([intro], 'data-width="1920" data-height="1080" data-duration="1"'),
      },
      "scene 'intro' ends at 2 s, after the root composition's data-duration of 1 s",
    ],
    [
      "more than ten minutes",
      withHosts([host("intro", "0", "601")]),
      "the video lasts 601 s; a video lasts at most 600 s",
    ],
    [
      "a scene file that is no template",
      withHosts([intro], { "scenes/intro.html": '<div data-composition-id="intro"></div>' }),
      "scenes/intro.html: a scene file is one <template> holding its composition",
    ],
    [
      "a template without a composition",
      withHosts([intro], { "scenes/intro.html": "<template><h1>Hi</h1></template>" }),
      "scenes/intro.html: its <template> holds no composition",
    ],
    [
      "a scene file of another composition",
      withHosts([intro], { "scenes/intro.html": scene("opening") }),
      "scenes/intro.html holds composition 'opening', but its host in index.html is 'intro'",
    ],
    [
      "a missing scene file",
      withHosts([intro, host("outro", "intro", "1")]),
      "index.html: scene 'outro' plays 'scenes/outro.html', which is not one of the video's files",
    ],
  ])("refuses %s", (_, files, message) => {
    const result = read(files)
    expect("error" in result && result.error).toContain(message)
  })

  // A 30 fps frame is 33.3 ms, a 25 fps one 40 ms. Reproduce by comparing `durationMs < end`
  // again in videoLength: the first two refuse.
  test.each([
    ["kept 20 ms past, as rounded seconds leave it", "30", "intro + 0.01", "8.01", undefined],
    ["kept 33 ms past at 30 fps", "30", "intro", "8.033", undefined],
    ["refused 34 ms past at 30 fps", "30", "intro", "8.034", "12.034"],
    ["refused a whole frame past at 25 fps", "25", "intro", "8.04", "12.04"],
  ])("a last scene ending past the video is %s", (_, fps, start, length, refusedEnd) => {
    const hosts = [intro4, host("demo", start, length)]
    const result = read({
      ...withHosts(hosts),
      "index.html": index(
        hosts,
        `data-width="1920" data-height="1080" data-fps="${fps}" data-duration="12"`
      ),
    })

    if (refusedEnd) {
      expect("error" in result && result.error).toContain(
        `scene 'demo' ends at ${refusedEnd} s, after the root composition's data-duration of 12 s`
      )
    } else {
      expect("composition" in result && result.composition.durationMs).toBe(12_000)
    }
  })

  test(`refuses more than ${ARTIFACT_LIMITS.maxVideoScenes} scenes`, () => {
    const hosts = Array.from({ length: ARTIFACT_LIMITS.maxVideoScenes + 1 }, (_, n) =>
      host(`s${n}`, String(n), "1")
    )
    const result = read({ "index.html": index(hosts) })
    expect("error" in result && result.error).toContain("a video holds at most 200 scenes")
  })
})

describe("the file a video's reference names", () => {
  const files = new Set(["media/clip.mp4", "scenes/still.png", "media/my clip.mp4"])
  const exists = (path: string) => files.has(path)

  test("is found as HyperFrames finds it: beside the scene, else from the project's root", () => {
    expect(videoFilePath("scenes/demo.html", "media/clip.mp4", exists)).toBe("media/clip.mp4")
    expect(videoFilePath("scenes/demo.html", "still.png", exists)).toBe("scenes/still.png")
    expect(videoFilePath("scenes/demo.html", "../media/clip.mp4", exists)).toBe("media/clip.mp4")
    expect(videoFilePath("index.html", "./media/clip.mp4", exists)).toBe("media/clip.mp4")
    expect(videoFilePath("scenes/demo.html", "media/my%20clip.mp4?v=2#t=3", exists)).toBe(
      "media/my clip.mp4"
    )
  })

  test("is none for a URL, a path from a site's root, or one that climbs out", () => {
    for (const value of [
      "https://cdn.example.com/clip.mp4",
      "//cdn.example.com/clip.mp4",
      "/media/clip.mp4",
      "artifact:art_k3m9q2x7tp/clip.mp4",
      "../../clip.mp4",
    ]) {
      expect(videoFilePath("scenes/demo.html", value, exists)).toBeUndefined()
    }
  })
})

describe("the files a video plays", () => {
  // Guard proof: drop the visit of nested compositions in videoFilesPlayed; the lower third's
  // logo is no longer played, and an update from a copy without it would lose it.
  test("are named by its root, each scene, and what each nests, all the way down", () => {
    const files: Record<string, string> = {
      "scenes/intro.html": scene(
        "intro",
        '<video src="../media/clip.mp4" muted></video><div data-composition-src="parts/third.html"></div>'
      ),
      "scenes/outro.html": scene("outro", "<h1>Thanks</h1>"),
      "parts/third.html": scene(
        "third",
        '<img src="logo.svg"><div data-composition-src="parts/third.html"></div>'
      ),
    }
    const held = new Set(["media/clip.mp4", "media/music.m4a", "parts/logo.svg", "media/old.mp4"])

    const played = videoFilesPlayed(
      index(
        [MUSIC, host("intro", "0", "4"), host("outro", "intro", "3")],
        'data-width="1920" data-height="1080" data-duration="7"'
      ),
      (path) => files[path],
      (path) => held.has(path) || path in files
    )
    expect([...played].sort()).toEqual(["media/clip.mp4", "media/music.m4a", "parts/logo.svg"])
  })

  test("are none when its root cannot be read, for publishing to say why", () => {
    expect(
      videoFilesPlayed(
        "<p>no video</p>",
        () => undefined,
        () => true
      ).size
    ).toBe(0)
  })
})

function setup() {
  const deps = createTestRuntimeDeps()
  const host = new SixbHost({ id: "videos", ontology: [], ...deps })
  const sixb = createTestSixb(host, {
    authorization: {
      principal: { type: "user", id: "alice" },
      groupIds: [],
      roleIds: [],
      grants: emptyGrantIndex(),
    },
  })

  const files = async (contents: Readonly<Record<string, string>>) => {
    const list: ArtifactFile[] = []
    for (const [path, body] of Object.entries(contents)) {
      const fileName = path.split("/").at(-1) ?? path
      const bytes = new TextEncoder().encode(body)
      list.push({
        path,
        file: await deps.blobStorage.put({
          body: bytes,
          fileName,
          mediaType: inferFileMediaType(fileName, bytes),
        }),
      })
    }
    return list
  }
  const publish = async (
    contents: Readonly<Record<string, string>>,
    kind: "video" | "document" | "page" = "video"
  ) => sixb.artifacts.create({ kind, title: "Launch film", files: await files(contents) })

  return { sixb, publish, files }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((caught: unknown) => caught)
  expect(error).toBeInstanceOf(ArtifactRequestError)
  return (error as Error).message
}

const keysOf = (outline: unknown) =>
  Object.fromEntries(
    (outline as VideoOutline).scenes.map((each) => [each.id, each.renderKey] as const)
  )

describe("publishing a video", () => {
  test("outlines its frame, its length, and its scenes", async () => {
    const { publish } = setup()
    const { version } = await publish(LAUNCH)

    expect(version.entry).toBe("index.html")
    expect(version.outline).toEqual({
      kind: "video",
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 7000,
      scenes: [
        {
          id: "intro",
          label: "Opening",
          startMs: 0,
          durationMs: 2000,
          renderKey: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
        { id: "demo", startMs: 2000, durationMs: 3000, renderKey: expect.any(String) },
        {
          id: "outro",
          label: "Thanks",
          startMs: 5500,
          durationMs: 1500,
          renderKey: expect.any(String),
        },
      ],
    })
  })

  // Removal proof: let sceneRenderKeys keep every file (drop its filter's last line), and a clip
  // only the demo plays renders every scene again; let it keep sounds, and other music does.
  test("renders again only the scenes a version changes, and shares them with a copy", async () => {
    const { publish } = setup()
    const before = keysOf((await publish(LAUNCH)).version.outline)
    const after = async (changes: Record<string, string>) =>
      keysOf((await publish({ ...LAUNCH, ...changes })).version.outline)

    // Another artifact holding the same files renders the same scenes.
    expect(await after({})).toEqual(before)

    // A scene's own HTML, or a recording only it plays, is its alone.
    expect(await after({ "scenes/intro.html": scene("intro", "<h1>Hello</h1>") })).toEqual({
      ...before,
      intro: expect.not.stringMatching(before.intro ?? ""),
    })
    expect(await after({ "media/clip.mp4": "another clip" })).toEqual({
      ...before,
      demo: expect.not.stringMatching(before.demo ?? ""),
    })

    // Any image or stylesheet, which a scene may load from its CSS or a script as well as from its
    // HTML: every scene.
    const everyScene: Record<string, string>[] = [
      { "media/logo.png": "another logo" },
      { "styles.css": "h1 { color: red; }" },
    ]
    for (const changes of everyScene) {
      const keys = await after(changes)
      for (const id of ["intro", "demo", "outro"]) expect(keys[id]).not.toBe(before[id])
    }

    // A sound is in no scene's frames: the export mixes the whole video's sound apart.
    expect(await after({ "media/music.m4a": "other music" })).toEqual(before)
  })

  // Removal proof: drop `data-poster` from what sceneRenderKeys cuts from the root, and moving the
  // poster renders every scene again.
  test("outlines its poster's instant, which renders no scene again", async () => {
    const { publish } = setup()
    const before = (await publish(LAUNCH)).version.outline
    const root = (LAUNCH["index.html"] ?? "").replace(
      'data-duration="7">',
      'data-duration="7" data-poster="2.4">'
    )
    const after = (await publish({ ...LAUNCH, "index.html": root })).version.outline

    expect(after).toMatchObject({ kind: "video", posterMs: 2400 })
    expect(keysOf(after)).toEqual(keysOf(before))
  })

  // Removal proof: let sceneRenderKeys hash all of index.html instead of `root`, and trimming the
  // demo renders the intro again; let it always leave out the scene's start, and the outro of the
  // video whose root moves keeps its key; let it always hold it, and the silent outro changes its
  // key.
  test("renders a trimmed scene again, and the scenes after it when the root moves", async () => {
    const { publish } = setup()
    const keys = async (root: string) =>
      keysOf((await publish({ ...LAUNCH, "index.html": root })).version.outline)
    const trim = (root: string) => root.replace('data-duration="3"', 'data-duration="2.5"')

    // Without music, each scene shows the same frames wherever it plays.
    const silent = (LAUNCH["index.html"] ?? "").replace(MUSIC, "").replace(' data-duration="7"', "")
    const untrimmed = await keys(silent)
    expect(await keys(trim(silent))).toEqual({
      ...untrimmed,
      demo: expect.not.stringMatching(untrimmed.demo ?? ""),
    })

    // A scene's own CSS animation and GSAP timeline run from its start, wherever it plays: an
    // outro that animates keeps its key too (measured with HyperFrames, see video/README.md).
    const animated = scene(
      "outro",
      "<style>h1 { animation: rise 1s }</style><script>window.__timelines = { outro: gsap.timeline() }</script>"
    )
    const moving = async (root: string) =>
      keysOf(
        (await publish({ ...LAUNCH, "index.html": root, "scenes/outro.html": animated })).version
          .outline
      ).outro
    expect(await moving(trim(silent))).toBe(await moving(silent))

    // A start written otherwise, or a new label, shows the same frames.
    const rewritten = silent.replace('data-start="intro"', 'data-start="2"')
    expect(await keys(rewritten.replace('data-label="Opening"', 'data-label="Hello"'))).toEqual(
      untrimmed
    )

    // Over music, too: a segment holds pictures alone.
    const scored = LAUNCH["index.html"] ?? ""
    const heard = await keys(scored)
    expect(await keys(trim(scored))).toEqual({
      ...heard,
      demo: expect.not.stringMatching(heard.demo ?? ""),
    })

    // Over a root that moves, the outro now plays over another moment of it.
    const grain = "<style>@keyframes grain { to { opacity: 0.5 } }</style>"
    const grained = silent.replace("<div data-composition-id", `${grain}\n<div data-composition-id`)
    const before = await keys(grained)
    expect(await keys(trim(grained))).toEqual({
      intro: before.intro,
      demo: expect.not.stringMatching(before.demo ?? ""),
      outro: expect.not.stringMatching(before.outro ?? ""),
    })
  })

  // Removal proof: let sceneRenderKeys keep the root's `<audio>` elements in `root` (drop
  // `composition.sounds` from its cut), and the intro renders again with the shorter music; let
  // it cut them without the space before, and the soundtrack moved onto the line above changes
  // every key; let rootSounds take an `<audio controls>`, and the player keeps every key.
  test("renders no scene again for a soundtrack trimmed with the video or played louder", async () => {
    const { publish } = setup()
    const scored = LAUNCH["index.html"] ?? ""
    const keys = async (root: string) =>
      keysOf((await publish({ ...LAUNCH, "index.html": root })).version.outline)
    const before = await keys(scored)

    // Half a second cut from the demo: the music, which ran to the end, ends with the video. Only
    // the demo changes: the outro starts earlier, which no frame of its own shows.
    const trimmed = scored
      .replace('data-duration="3"', 'data-duration="2.5"')
      .replaceAll('data-duration="7"', 'data-duration="6.5"')
    expect(await keys(trimmed)).toEqual({
      ...before,
      demo: expect.not.stringMatching(before.demo ?? ""),
    })

    // How loud it plays, and on a line of its own or not, shows in no frame.
    const louder = scored.replace(MUSIC, MUSIC.replace("<audio", '<audio data-volume="0.4"'))
    expect(await keys(louder)).toEqual(before)
    expect(await keys(scored.replace(`\n${MUSIC}`, MUSIC))).toEqual(before)

    // A player with controls shows on every frame.
    const shown = await keys(scored.replace(MUSIC, MUSIC.replace("<audio", "<audio controls")))
    for (const id of ["intro", "demo", "outro"]) expect(shown[id]).not.toBe(before[id])
  })

  // Removal proof: let linksMove return false, and the moving stylesheet, the stylesheet from
  // elsewhere, and the timeline script leave the outro's key as it was; let it return true, and the
  // libraries and the still stylesheets change it.
  test("reads what the root links to tell whether it moves", async () => {
    const { publish } = setup()
    const silent = (LAUNCH["index.html"] ?? "").replace(MUSIC, "").replace(' data-duration="7"', "")
    const outroMoves = async (head: string, files: Record<string, string> = {}) => {
      const linked = silent.replace("<html>", `<html><head>${head}</head>`)
      const keys = async (root: string) =>
        keysOf((await publish({ ...LAUNCH, ...files, "index.html": root })).version.outline).outro
      return (
        (await keys(linked)) !==
        (await keys(linked.replace('data-duration="3"', 'data-duration="2.5"')))
      )
    }
    const css = (href: string) => `<link rel="stylesheet" href="${href}">`
    const script = (src: string) => `<script src="${src}"></script>`

    // Still: a stylesheet of the version without motion, Google Fonts, and libraries.
    expect(await outroMoves(css("styles.css"))).toBe(false)
    expect(await outroMoves(css("https://fonts.googleapis.com/css2?family=Inter"))).toBe(false)
    expect(
      await outroMoves(script("https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"))
    ).toBe(false)
    expect(await outroMoves(script("lib.js"), { "lib.js": "window.ease = (t) => t" })).toBe(false)

    // Moving: a stylesheet that animates, one nobody can read, and a script that registers a timeline.
    expect(
      await outroMoves(css("styles.css"), {
        "styles.css": "@keyframes grain { to { opacity: 0 } }",
      })
    ).toBe(true)
    expect(
      await outroMoves(css("https://cdn.jsdelivr.net/npm/animate.css@4.1.1/animate.min.css"))
    ).toBe(true)
    expect(
      await outroMoves(script("timeline.js"), {
        "timeline.js": "window.__timelines = { main: gsap.timeline({ paused: true }) }",
      })
    ).toBe(true)
  })

  // Removal proof: let sceneRenderKeys take the scene alone as `beside`, and the outro keeps its
  // key under the demo's new clip.
  test("renders a scene again with the scene that fades into it", async () => {
    const { publish } = setup()
    const crossfade = (LAUNCH["index.html"] ?? "").replace("demo + 0.5", "demo - 0.5")
    const keys = async (changes: Record<string, string> = {}) =>
      keysOf((await publish({ ...LAUNCH, "index.html": crossfade, ...changes })).version.outline)

    const before = await keys()
    expect(await keys({ "media/clip.mp4": "another clip" })).toEqual({
      intro: before.intro,
      demo: expect.not.stringMatching(before.demo ?? ""),
      outro: expect.not.stringMatching(before.outro ?? ""),
    })
  })

  // Removal proof: drop the nesting loop in validateVideo's `load`, and the missing composition
  // publishes, and the scene keeps its key under a new clip.
  test("reads the compositions a scene nests, and what they play", async () => {
    const { publish } = setup()
    const lower = (body: string) =>
      `<template><div data-composition-id="lower" data-width="1920" data-height="1080">${body}</div></template>`
    const nesting = {
      ...LAUNCH,
      "scenes/intro.html": scene(
        "intro",
        '<div data-composition-id="lower" data-composition-src="compositions/lower.html" data-start="0.5" data-duration="1"></div>'
      ),
      "compositions/lower.html": lower('<video src="media/wave.mp4" muted></video>'),
      "media/wave.mp4": "wave",
    }
    const keys = async (changes: Record<string, string> = {}) =>
      keysOf((await publish({ ...nesting, ...changes })).version.outline)

    const before = await keys()
    expect(await keys({ "media/wave.mp4": "another wave" })).toEqual({
      ...before,
      intro: expect.not.stringMatching(before.intro ?? ""),
    })

    const { "compositions/lower.html": _, ...missing } = nesting
    expect(await refusal(publish(missing))).toContain(
      'scenes/intro.html: <div data-composition-src="compositions/lower.html"> nests a composition that is not one of the video\'s files'
    )
    expect(
      await refusal(
        publish({ ...nesting, "compositions/lower.html": lower('<img src="media/x.png">') })
      )
    ).toContain("compositions/lower.html: <img src=\"media/x.png\"> plays 'media/x.png'")
    const loop = lower(
      '<div data-composition-id="intro" data-composition-src="scenes/intro.html"></div>'
    )
    expect(await refusal(publish({ ...nesting, "compositions/lower.html": loop }))).toContain(
      "nests 'scenes/intro.html', which nests compositions/lower.html in turn"
    )
  })

  test("resolves the files of other artifacts its scenes play", async () => {
    const { publish } = setup()
    const library = await publish({ "index.html": "<main></main>", "intro.mp4": "clip" }, "page")
    const address = `artifact:${library.artifact.id}/intro.mp4`

    const { version } = await publish({
      ...LAUNCH,
      "scenes/intro.html": scene("intro", `<video src="${address}"></video>`),
    })
    expect(version.references).toEqual([{ address, as: "embed", at: "intro", resolvedVersion: 1 }])
  })

  // Removal proof: share one `loaded` map across scenes in validateVideo's `load`, and the outro's
  // reference is never recorded.
  test("resolves a file of another artifact at each scene that nests the composition playing it", async () => {
    const { publish } = setup()
    const library = await publish({ "index.html": "<main></main>", "intro.mp4": "clip" }, "page")
    const address = `artifact:${library.artifact.id}/intro.mp4`
    const lower =
      '<div data-composition-id="lower" data-composition-src="compositions/lower.html"></div>'

    const { version } = await publish({
      ...LAUNCH,
      "scenes/intro.html": scene("intro", lower),
      "scenes/outro.html": scene("outro", lower),
      "compositions/lower.html": `<template><div data-composition-id="lower" data-width="1920" data-height="1080"><video src="${address}" muted></video></div></template>`,
    })
    expect(version.references).toEqual([
      { address, as: "embed", at: "intro", resolvedVersion: 1 },
      { address, as: "embed", at: "outro", resolvedVersion: 1 },
    ])
  })

  test.each([
    ["no index.html", { "index.html": null }, "A video needs 'index.html', its root composition"],
    [
      "a file under __sixb/",
      { "__sixb/runtime.js": "" },
      "'__sixb/runtime.js' is under __sixb/, where Sixb serves the video's kit",
    ],
    [
      "a missing scene file",
      { "scenes/outro.html": null },
      "scene 'outro' plays 'scenes/outro.html', which is not one of the video's files",
    ],
    [
      "a missing clip",
      { "scenes/demo.html": scene("demo", '<video src="media/missing.mp4"></video>') },
      `scenes/demo.html: <video src="media/missing.mp4"> plays 'media/missing.mp4', which is not one of the video's files`,
    ],
    [
      "a clip from elsewhere",
      { "scenes/demo.html": scene("demo", '<source src="https://cdn.example.com/clip.mp4">') },
      `scenes/demo.html: <source src="https://cdn.example.com/clip.mp4"> plays a file from outside the video`,
    ],
    [
      "an artifact without its file",
      { "scenes/demo.html": scene("demo", '<video src="artifact:art_k3m9q2x7tp"></video>') },
      `<video src="artifact:art_k3m9q2x7tp"> names no file of that artifact`,
    ],
    ["a query", { "queries/units.json": "{}" }, "'queries/units.json': a video runs no query"],
    [
      "a scene past its size",
      { "scenes/intro.html": scene("intro", "x".repeat(ARTIFACT_LIMITS.maxSceneBytes)) },
      `each of a video's HTML files holds at most ${ARTIFACT_LIMITS.maxSceneBytes}`,
    ],
  ] satisfies [
    string,
    Record<string, string | null>,
    string,
  ][])("refuses %s", async (_, changes, message) => {
    const { publish } = setup()
    const files = Object.entries({ ...LAUNCH, ...changes }).flatMap(([path, text]) =>
      text === null ? [] : [[path, text] as const]
    )
    expect(await refusal(publish(Object.fromEntries(files)))).toContain(message)
  })

  test(`refuses more than ${ARTIFACT_LIMITS.maxVideoMediaFiles} video and sound files`, async () => {
    const { publish } = setup()
    const clips = Object.fromEntries(
      Array.from({ length: ARTIFACT_LIMITS.maxVideoMediaFiles }, (_, n) => [
        `media/take-${n}.mp4`,
        `take ${n}`,
      ])
    )
    // The launch film plays one clip and one soundtrack already: two more than enough.
    expect(await refusal(publish({ ...LAUNCH, ...clips }))).toContain(
      "A video holds at most 50 video and sound files; this one has 52"
    )
  })

  // Guard proof: drop refuseLargePages from validateVideo; a page no scene names is never read,
  // and the version publishes.
  test(`refuses an HTML file over ${ARTIFACT_LIMITS.maxSceneBytes} bytes that no scene names`, async () => {
    const { publish } = setup()
    const notes = "x".repeat(ARTIFACT_LIMITS.maxSceneBytes + 1)

    expect(await refusal(publish({ ...LAUNCH, "notes/transcript.htm": notes }))).toContain(
      `'notes/transcript.htm' is ${ARTIFACT_LIMITS.maxSceneBytes + 1} bytes: each of a video's HTML files holds at most ${ARTIFACT_LIMITS.maxSceneBytes}.`
    )
  })
})

describe("an address into a video", () => {
  const outline: VideoOutline = {
    kind: "video",
    width: 1920,
    height: 1080,
    fps: 30,
    durationMs: 70_000,
    scenes: [
      { id: "intro", label: "Opening", startMs: 0, durationMs: 4000, renderKey: "a" },
      { id: "demo", startMs: 4000, durationMs: 66_000, renderKey: "b" },
    ],
  }
  const resolve = (part: string) =>
    resolveArtifactAddress(
      parseArtifactAddress(`artifact:art_k3m9q2x7tp#${part}`) ?? { artifactId: "" },
      {
        kind: "video",
        outline,
        files: [],
      }
    )

  test("names a scene, with its times", () => {
    expect(resolve("intro")).toEqual({
      part: { type: "scene", id: "intro", label: "Opening", startMs: 0, durationMs: 4000 },
    })
    expect(resolve("demo")).toEqual({
      part: { type: "scene", id: "demo", startMs: 4000, durationMs: 66_000 },
    })
  })

  test("names an instant as Media Fragments write it", () => {
    expect(resolve("t=12.5")).toEqual({ part: { type: "time", ms: 12_500 } })
    expect(resolve("t=npt:12.5")).toEqual({ part: { type: "time", ms: 12_500 } })
    expect(resolve("t=1:05")).toEqual({ part: { type: "time", ms: 65_000 } })
    expect(resolve("t=0:01:05.5")).toEqual({ part: { type: "time", ms: 65_500 } })
    expect(resolve("t=70")).toEqual({ part: { type: "time", ms: 70_000 } })
  })

  test("says what the video has instead", () => {
    expect(resolve("t=71")).toEqual({ problem: "has no instant t=71: it lasts 70 s" })
    expect(resolve("outro")).toEqual({
      problem:
        "has no scene 'outro'; its scenes are 'intro', 'demo', and names an instant as t=12.5",
    })
    // A range, or seconds past a minute in a clock, is no instant.
    expect(resolve("t=10,20")).toMatchObject({ problem: expect.stringContaining("has no scene") })
    expect(resolve("t=0:75")).toMatchObject({ problem: expect.stringContaining("has no scene") })
  })

  test("is checked when another artifact links to it", async () => {
    const { publish } = setup()
    const film = await publish(LAUNCH)
    const link = (part: string) =>
      publish({ "index.html": `<a href="artifact:${film.artifact.id}#${part}">Watch</a>` }, "page")

    expect((await link("demo")).version.references).toMatchObject([{ as: "link" }])
    expect((await link("t=6")).version.references).toMatchObject([{ as: "link" }])
    expect(await refusal(link("t=8"))).toContain("has no instant t=8: it lasts 7 s")
  })
})

describe("comments on a video", () => {
  /** A comment as a quote names it, without its id. */
  const quoted = ({ anchor, body }: { anchor: ArtifactCommentAnchor; body: string }) => ({
    anchor,
    body,
  })

  test("are about an instant, the scene it plays, and a point on the frame", async () => {
    const { sixb, publish } = setup()
    const { artifact, version } = await publish(LAUNCH)

    const comment = await sixb.artifacts.addComment(artifact.id, {
      body: "Hold the logo longer",
      anchor: { at: 6200, scene: "outro", point: { x: 0.5, y: 0.4 } },
    })
    expect(comment.anchor).toEqual({
      scene: "outro",
      label: "Thanks",
      offset: 700,
      point: { x: 0.5, y: 0.4 },
      revision: 1,
    })
    expect(
      quoteArtifactComment({ ...quoted(comment), outline: version.outline as VideoOutline })
    ).toBe("[0:06 · outro · revision 1] Hold the logo longer")

    // An instant that names no scene is kept in the one playing then.
    const unnamed = await sixb.artifacts.addComment(artifact.id, {
      body: "Slower",
      anchor: { at: 3000 },
    })
    expect(unnamed.anchor).toEqual({ scene: "demo", offset: 1000, revision: 1 })

    const scene = await sixb.artifacts.addComment(artifact.id, {
      body: "Too fast",
      anchor: { scene: "demo" },
    })
    expect(scene.anchor).toEqual({ scene: "demo", revision: 1 })
  })

  // Guard proof: give a comment the scene that started last before its instant in checkScenePlace
  // (`outline.scenes.filter((each) => each.startMs <= at).at(-1)`), as the player once did, and
  // the one between the demo and the outro is kept 3.2 s into the 3 s demo.
  test("are about any instant, one between two scenes in none", async () => {
    const { sixb, publish } = setup()
    const { artifact, version } = await publish(LAUNCH)

    // The demo ends at 5 s, and the outro starts half a second later.
    const gap = await sixb.artifacts.addComment(artifact.id, { body: "Hold", anchor: { at: 5200 } })
    expect(gap.anchor).toEqual({ at: 5200, revision: 1 })
    expect(quoteArtifactComment({ ...quoted(gap), outline: version.outline as VideoOutline })).toBe(
      "[0:05 · revision 1] Hold"
    )
  })

  // Guard proof: keep `at` as it is sent in checkScenePlace (`{ at, scene }`), and the comment
  // stays at 30.5 s once the demo is cut, 13 s into the outro.
  test("follow their scene when a later version moves it, and say when it is gone", async () => {
    const { sixb, publish, files } = setup()
    const film = (demo: number, outro = "15") => ({
      ...LAUNCH,
      "index.html": index([
        host("intro", "0", "2"),
        host("demo", "intro", String(demo)),
        host("outro", "demo + 0.5", outro, ' data-label="Thanks"'),
      ]),
    })
    const { artifact } = await publish(film(18))
    const comment = await sixb.artifacts.addComment(artifact.id, {
      body: "Hold the logo longer",
      anchor: { at: 30_500, scene: "outro" },
    })
    const update = async (contents: Readonly<Record<string, string>>) => {
      const { version } = await sixb.artifacts.update(artifact.id, {
        kind: "video",
        title: "Launch film",
        files: await files(contents),
      })
      return version.outline as VideoOutline
    }
    const [kept] = (await sixb.artifacts.listComments(artifact.id)) ?? []
    expect(kept?.anchor).toEqual(comment.anchor)

    // Three seconds cut from the demo: the outro starts at 17.5 s, and the comment 10 s into it.
    const cut = await update(film(15))
    expect(placeVideoComment(comment.anchor, cut)).toMatchObject({
      ms: 27_500,
      scene: { id: "outro" },
    })
    expect(quoteArtifactComment({ ...quoted(comment), outline: cut })).toBe(
      "[0:27 · outro · revision 1] Hold the logo longer"
    )

    // An outro shorter than the comment's offset holds it at its end.
    expect(placeVideoComment(comment.anchor, await update(film(15, "4")))).toMatchObject({
      ms: 21_500,
    })

    // Without the outro, it has no instant, and its label names the scene it was in.
    const gone = await update({ ...film(15), "index.html": index([host("intro", "0", "2")]) })
    expect(placeVideoComment(comment.anchor, gone)).toEqual({ gone: true })
    expect(quoteArtifactComment({ ...quoted(comment), outline: gone })).toBe(
      '[outro · "Thanks" · no longer in the video · revision 1] Hold the logo longer'
    )
    expect(quoteArtifactComment(quoted(comment))).toBe(
      "[0:10 into outro · revision 1] Hold the logo longer"
    )
  })

  // Guard proof: return `{ ...anchor }` from checkScenePlace in comments.ts, and each is kept.
  test.each([
    [{ scene: "credits" }, "The video has no scene 'credits'."],
    [{ at: 7001 }, "`at` is 0 to 7000 milliseconds"],
    [{ at: -1 }, "`at` is 0 to 7000 milliseconds"],
    [{ at: 1.5 }, "`at` is 0 to 7000 milliseconds"],
    [{ point: { x: 0.5, y: 0.5 } }, "A comment's point is on the frame at its instant"],
    [{ at: 1000, point: { x: 1.5, y: 0.5 } }, "x and y from 0 to 1"],
    [{ at: 5200, scene: "demo" }, "Scene 'demo' plays from 2000 to 5000 milliseconds"],
    [{ board: "intro" }, "A comment on a video is about an instant or a scene, not a board."],
  ])("refuses an anchor %o", async (anchor, message) => {
    const { sixb, publish } = setup()
    const { artifact } = await publish(LAUNCH)
    const error = await sixb.artifacts
      .addComment(artifact.id, { body: "Hm", anchor })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: "invalid_comment",
      message: expect.stringContaining(message),
    })
  })

  test("are not about an instant on another kind", async () => {
    const { sixb, publish } = setup()
    const { artifact } = await publish({ "document.md": "# Plan\n" }, "document")
    const error = await sixb.artifacts
      .addComment(artifact.id, { body: "Hm", anchor: { at: 1000 } })
      .catch((caught: unknown) => caught)
    expect(error).toMatchObject({
      code: "invalid_comment",
      message: expect.stringContaining("A comment on a document is about the whole artifact"),
    })
  })
})
