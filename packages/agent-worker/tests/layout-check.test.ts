import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ArtifactTheme } from "@sixb/core/artifacts"
import type { CommandResult, RunCommandOptions } from "@sixb/core/sandboxes"
import { checkLayout, layoutWarnings } from "../src/artifacts/layout-check/layout-check"
import { LocalBashSandbox } from "./helpers"

type Problem = Parameters<typeof layoutWarnings>[0][number]

const rect = { x: 96, y: 72, width: 200, height: 22 }
const problem = (overrides: Partial<Problem>): Problem => ({
  code: "small_text",
  rect,
  text: "Q3 2026",
  selector: "p.eyebrow",
  size: 16,
  slide: 1,
  theme: "light",
  ...overrides,
})

describe("layout warnings", () => {
  test("name one cause once, with every slide it is on, worst first", () => {
    const warnings = layoutWarnings([
      problem({ slide: 1, text: "Q3 2026" }),
      problem({ slide: 2, text: "Highlights" }),
      problem({ slide: 3, text: "Regions" }),
      problem({ slide: 5, text: "Parts" }),
      problem({ slide: 2, theme: "dark", text: "Highlights" }),
      problem({ code: "outside", slide: 4, text: "A long table", selector: "table" }),
      problem({
        code: "contrast",
        slide: 2,
        theme: "dark",
        selector: "span.kicker",
        text: "Territories",
        ratio: 2.72,
        colors: ["#1d5f68", "#0a0a0a"],
      }),
    ])
    expect(warnings).toEqual([
      {
        code: "layout_outside",
        part: "4",
        message:
          "Slide 4: table “A long table” runs past the slide's edge at 96,72 (200×22), which cuts it off.",
      },
      {
        code: "layout_contrast",
        part: "2",
        message:
          "Slide 2: span.kicker “Territories” has a contrast of 2.72:1 (#1d5f68 on #0a0a0a), under WCAG AA in dark mode.",
      },
      {
        code: "layout_small_text",
        part: "1",
        message:
          "Slides 1–3 and 5: p.eyebrow “Q3 2026”, “Highlights” and 2 more are 16px; nothing on a slide may be under 18px.",
      },
    ])
  })

  test("name a page's problems by the widths they are at, with a page's own limits", () => {
    const warnings = layoutWarnings([
      problem({ slide: undefined, view: "desktop", size: 11, text: "Updated daily" }),
      problem({ slide: undefined, view: "phone", size: 11, text: "Updated daily" }),
      problem({
        code: "small_target",
        slide: undefined,
        view: "phone",
        selector: "button.ghost",
        text: "×",
        size: 18,
      }),
    ])
    expect(warnings).toEqual([
      {
        code: "layout_small_target",
        part: "phone",
        message:
          "On a phone (390px): button.ghost “×” is 18px across; make each control at least 24px each way.",
      },
      {
        code: "layout_small_text",
        part: "desktop",
        message:
          "At 1280px and on a phone (390px): p.eyebrow “Updated daily” is 11px; nothing on a page may be under 12px.",
      },
    ])
  })

  test("stop at twelve, and say how many more the screenshots show", () => {
    const warnings = layoutWarnings(
      Array.from({ length: 15 }, (_, index) =>
        problem({ code: "outside", slide: index + 1, text: `Table ${index + 1}` })
      )
    )
    expect(warnings).toHaveLength(13)
    expect(warnings.at(-1)).toEqual({
      code: "layout_more",
      message: "3 more layout problems; the screenshots show them.",
    })
  })
})

describe("the layout check", () => {
  let root: string
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "sixb-layout-check-")))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  /** A sandbox whose check answers with `answer`, recording the command it ran. */
  function sandbox(answer: Partial<CommandResult>) {
    const local = new LocalBashSandbox(root)
    const commands: { args: readonly string[]; options: RunCommandOptions }[] = []
    const written: string[] = []
    const writeFiles = local.writeFiles.bind(local)
    local.writeFiles = async (files) => {
      written.push(...files.map((file) => file.path))
      await writeFiles(files)
    }
    local.runCommand = async (_command, args = [], options = {}) => {
      commands.push({ args, options })
      return { exitCode: 0, stdout: "", stderr: "", durationMs: 1, ...answer }
    }
    return { handle: { sandbox: local }, commands, written }
  }
  const check = (
    handle: { sandbox: LocalBashSandbox; env?: Record<string, string> },
    options: {
      readonly name?: string
      readonly timeoutMs?: number
      readonly theme?: ArtifactTheme
      readonly layout?: "deck" | "page"
    } = {}
  ) =>
    checkLayout({
      handle,
      layout: options.layout ?? "deck",
      directory: join(root, "deck"),
      files: ["index.html", "img/chart.png"],
      entry: new TextEncoder().encode("<!doctype html><html><head></head><body></body></html>"),
      name: options.name ?? "art_0000000000-v1",
      signal: new AbortController().signal,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.theme === undefined ? {} : { theme: options.theme }),
    })

  test("installs the kit, the runtime, and the probe, and serves the entry with them", async () => {
    const { handle, commands, written } = sandbox({
      stdout: JSON.stringify({
        layout: "deck",
        slides: 1,
        problems: [problem({})],
        errors: ["img/chart.png did not load (404)"],
        screenshots: [join(root, ".sixb/agent/checks/art_0000000000-v1/slide-01.png")],
      }),
    })
    expect(await check(handle)).toEqual({
      status: "checked",
      screenshots: [".sixb/agent/checks/art_0000000000-v1/slide-01.png"],
      warnings: [
        {
          code: "layout_small_text",
          part: "1",
          message: "Slide 1: p.eyebrow “Q3 2026” is 16px; nothing on a slide may be under 18px.",
        },
        {
          code: "layout_load_error",
          message: "While the deck loaded: img/chart.png did not load (404).",
        },
      ],
    })
    const library = join(root, ".sixb/agent/lib/layout-check")
    expect(readFileSync(join(library, "deck.css"), "utf8")).toContain("@layer sixb-kit")
    expect(readFileSync(join(library, "runtime.js"), "utf8")).toContain("sixb-frame/1")
    expect(readFileSync(join(library, "probe.js"), "utf8")).toStartWith("(function layoutProbe")
    expect(
      readFileSync(join(root, ".sixb/agent/checks/art_0000000000-v1/entry.html"), "utf8")
    ).toContain(
      '<head><link rel="stylesheet" href="__sixb/deck.css"><script src="__sixb/runtime.js" data-sixb-layout="deck"></script>'
    )
    expect(commands[0]?.options.env).toMatchObject({ SIXB_CHECK_DECK: join(root, "deck") })
    // It serves the files the version publishes, and no others from the deck's directory.
    // Reproduce by serving the whole directory: work/q3/img/ loads for a publish of index.html.
    const output = join(root, ".sixb/agent/checks/art_0000000000-v1")
    expect(JSON.parse(readFileSync(join(output, "files.json"), "utf8"))).toEqual([
      "index.html",
      "img/chart.png",
    ])

    // A deck is measured in both of Sixb's themes, unless its theme.json pins one, and with its
    // tokens, as the reader's frame shows it. Reproduce by measuring every deck in Sixb's themes
    // alone: the second, light with its own foreground, is measured in dark and in Sixb's ink.
    const themes = (name: string) =>
      JSON.parse(readFileSync(join(root, ".sixb/agent/checks", name, "themes.json"), "utf8"))
    expect(Object.keys(themes("art_0000000000-v1"))).toEqual(["light", "dark"])

    // The library is written once for the run's sandbox; each check writes its own entry.
    await check(handle, {
      name: "art_0000000000-v2",
      theme: { mode: "light", tokens: { "--foreground": "#2b2b2b" } },
    })
    expect(Object.keys(themes("art_0000000000-v2"))).toEqual(["light"])
    expect(themes("art_0000000000-v2").light).toMatchObject({
      dark: false,
      tokens: { "--foreground": "#2b2b2b", "--background": "#fafafa" },
    })
    expect(written.filter((path) => path.startsWith(library))).toHaveLength(5)
    expect(written.filter((path) => path.endsWith("/entry.html"))).toHaveLength(2)
  })

  test("keeps what a check reported, however its command ended", async () => {
    const report = {
      layout: "deck",
      slides: 4,
      problems: [problem({ slide: 2 })],
      errors: [],
      screenshots: [join(root, ".sixb/agent/checks/art_0000000000-v1/slide-01.png")],
      stopped: "slide 3 in light mode did not respond within 10 seconds",
    }
    // The check printed its report, then outlived the timeout on its way out. Reproduce by
    // looking at `timedOut` before the report: the check reads as skipped.
    const result = await check(
      sandbox({ exitCode: 137, timedOut: true, stdout: JSON.stringify(report) }).handle
    )
    expect(result).toEqual({
      status: "checked",
      screenshots: [".sixb/agent/checks/art_0000000000-v1/slide-01.png"],
      warnings: [
        {
          code: "layout_small_text",
          part: "2",
          message: "Slide 2: p.eyebrow “Q3 2026” is 16px; nothing on a slide may be under 18px.",
        },
        {
          code: "layout_incomplete",
          message:
            "The check stopped early: slide 3 in light mode did not respond within 10 seconds. Slides it did not reach were not checked.",
        },
      ],
    })
  })

  test.skipIf(!Bun.which("node"))(
    "stops at its deadline when the page stops answering, and reports what it found",
    async () => {
      // A Playwright whose page answers for the first slide and never again, like a deck whose
      // script never yields, and whose browser connection keeps node alive as Chromium's does.
      // Reproduce by removing check.cjs's deadline: nothing is reported until the command's
      // timeout kills node, and the check reads as skipped, with the browser left running.
      const playwright = join(root, "fake-playwright.cjs")
      writeFileSync(
        playwright,
        `const { writeFileSync } = require("node:fs")
exports.chromium = {
  async launch() {
    const connection = setInterval(() => {}, 1000)
    const page = {
      on() {},
      async goto() {},
      async addStyleTag() {},
      async evaluate(fn) {
        if (typeof fn === "string") return []
        return String(fn).includes(".length") ? 2 : undefined
      },
      waitForFunction: (_fn, slide) => (slide === 1 ? Promise.resolve() : new Promise(() => {})),
      async screenshot({ path }) {
        writeFileSync(path, "png")
      },
    }
    return { newPage: async () => page, close: async () => clearInterval(connection) }
  },
}
`
      )
      // A 600ms timeout puts the check's deadline at 500ms. The sandbox kills the command only
      // after five seconds, so a slow start of node never reads as the deadline.
      const sandbox = new LocalBashSandbox(root)
      const run = sandbox.runCommand.bind(sandbox)
      sandbox.runCommand = (command, args, options) =>
        run(command, args, { ...options, timeout: 5_000 })
      const handle = { sandbox, env: { SIXB_PLAYWRIGHT: playwright } }
      expect(await check(handle, { timeoutMs: 600 })).toEqual({
        status: "checked",
        screenshots: [".sixb/agent/checks/art_0000000000-v1/slide-01.png"],
        warnings: [
          {
            code: "layout_incomplete",
            message:
              "The check stopped early: the check took longer than 1 seconds. Slides it did not reach were not checked.",
          },
        ],
      })
    },
    10_000
  )

  test("lays a page out in the page layout, at a laptop's width and a phone's", async () => {
    // Reproduce by passing "deck" to injectFrameAssets for every check: the page asks for the
    // deck's kit, and its runtime lays it out as slides.
    const output = join(root, ".sixb/agent/checks/art_0000000000-v1")
    const { handle, commands } = sandbox({
      stdout: JSON.stringify({
        layout: "page",
        slides: 0,
        problems: [
          problem({
            code: "wide",
            slide: undefined,
            view: "phone",
            selector: "table",
            text: "Region",
            rect: { x: 16, y: 480, width: 620, height: 240 },
          }),
        ],
        errors: ["Uncaught TypeError: plan is not a function"],
        screenshots: [join(output, "desktop.png"), join(output, "phone.png")],
      }),
    })
    expect(await check(handle, { layout: "page" })).toEqual({
      status: "checked",
      screenshots: [
        ".sixb/agent/checks/art_0000000000-v1/desktop.png",
        ".sixb/agent/checks/art_0000000000-v1/phone.png",
      ],
      warnings: [
        {
          code: "layout_wide",
          part: "phone",
          message:
            "On a phone (390px): table “Region” runs past the screen's right edge at 16,480 (620×240), so the whole page scrolls sideways; let it wrap or shrink, or put it in a box that scrolls (.table-scroll).",
        },
        {
          code: "layout_load_error",
          message: "While the page loaded: Uncaught TypeError: plan is not a function.",
        },
      ],
    })
    expect(readFileSync(join(output, "entry.html"), "utf8")).toContain(
      '<link rel="stylesheet" href="__sixb/page.css"><script src="__sixb/runtime.js" data-sixb-layout="page">'
    )
    expect(commands[0]?.options.env).toMatchObject({ SIXB_CHECK_LAYOUT: "page" })
  })

  test("counts a report for another layout as a failed check", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      const report = JSON.stringify({ layout: "deck", slides: 1, problems: [], screenshots: [] })
      expect(await check(sandbox({ stdout: report }).handle, { layout: "page" })).toEqual({
        status: "skipped",
        reason: "the check failed in the sandbox",
      })
    } finally {
      warn.mockRestore()
    }
  })

  test("says it did not run without a browser, or when it fails, and never refuses", async () => {
    expect(await check(sandbox({ stdout: '{"skipped":"no_browser"}\n' }).handle)).toEqual({
      status: "skipped",
      reason: "the sandbox has no headless browser (the agent image has one)",
    })
    expect(await check(sandbox({ stdout: '{"skipped":"no_node"}' }).handle)).toEqual({
      status: "skipped",
      reason: "the sandbox has no Node.js",
    })
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      expect(await check(sandbox({ exitCode: 1, stderr: "Segmentation fault" }).handle)).toEqual({
        status: "skipped",
        reason: "the check failed in the sandbox",
      })
      expect(warn.mock.calls[0]?.[0]).toContain("Segmentation fault")
    } finally {
      warn.mockRestore()
    }
    expect(await check(sandbox({ exitCode: 137, timedOut: true }).handle)).toEqual({
      status: "skipped",
      reason: "it took longer than 120 seconds",
    })
  })
})
