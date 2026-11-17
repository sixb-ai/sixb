import { posix } from "node:path"
import type { Sandbox } from "@sixb/core"
import type { ArtifactTheme, Canvas, DocumentPaper } from "@sixb/core/artifacts"
import {
  FRAME_ASSETS,
  FRAME_DEFAULT_THEMES,
  type FrameLayout,
  injectFrameAssets,
  type LayoutProblem,
  layoutProbe,
  rewriteFrameReferences,
} from "@sixb/core/internal/artifacts/frames"
import { type ArtifactQueryAnswer, artifactThemeModes } from "@sixb/core/internal/artifacts/publish"
import { loginShellArgs } from "../../login-shell"
import { type AgentSandboxHandle, contextPath } from "../../sandbox-handle"
import checkScript from "./check.cjs" with { type: "text" }
import { canvasOverviewHtml, OVERVIEW_VIEWPORT } from "./overview"

/** The check's library and each check's files, in the run's context directory. */
const LIBRARY = "lib/layout-check"
const CHECKS = "checks"
/** Chromium's start, a deck's fonts, and two passes over up to 100 slides, or a page at two widths. */
const CHECK_TIMEOUT_MS = 120_000
/**
 * Sandboxes the check's library is written in. The context directory lasts the run, and each run
 * has its own sandbox object, a lasting sandbox's included, so the library is written once per run.
 */
const installed = new WeakSet<Sandbox>()

/** What the layout check found, for the publish tool to report beside the version. */
export type LayoutCheck =
  | {
      readonly status: "checked"
      readonly warnings: readonly LayoutWarning[]
      /** One per slide, a page's at each width, or a document's pages, as the agent names them. */
      readonly screenshots: readonly string[]
      /** How many pages a designed document with paper was cut into. */
      readonly pages?: number
      /** A canvas as it opens in the app, as the agent names it, when the check took it. */
      readonly overview?: string
    }
  | { readonly status: "skipped"; readonly reason: string }

export interface LayoutWarning {
  readonly code: string
  readonly message: string
  /** The slide's number, or the width a page was checked at: `desktop` or `phone`. */
  readonly part?: string
}

/** What the check lays out: a deck, a page, or a canvas's boards, each a page at its own size. */
export type CheckLayout = FrameLayout | "canvas"

/** A canvas's board, as the check opens it. */
export interface CheckedBoard {
  readonly id: string
  /** Its HTML file, relative to the version's directory. */
  readonly file: string
  readonly w: number
  readonly h: number
  readonly html: Uint8Array
}

interface CheckReport {
  /** The layout the check laid the entry out in, which says it ran to the end of its setup. */
  readonly layout?: CheckLayout
  readonly slides?: number
  readonly pages?: number
  readonly problems?: readonly CheckedProblem[]
  readonly errors?: readonly string[]
  readonly screenshots?: readonly string[]
  /** A canvas's boards whose page draws larger than the board's `w` by `h`. */
  readonly oversized?: readonly OversizedBoard[]
  /** A canvas's boards that stopped answering, which the check went on without. */
  readonly stalls?: readonly { readonly board: string; readonly message: string }[]
  readonly overview?: string
  /** Why the check stopped before it finished; what it found until then is above. */
  readonly stopped?: string
  readonly skipped?: string
  readonly detail?: string
  readonly failed?: string
}

/**
 * What a page's `sixb.query(name)` reads in the check: the query route's JSON as it answers the
 * requester, or why the query failed for them.
 */
export type CheckedQuery = ArtifactQueryAnswer

/** A width a page is checked at, as a laptop and a phone show it. */
export type PageView = "desktop" | "phone"

/**
 * Lays a published deck, page, designed document, or canvas out in the sandbox's headless
 * Chromium, as the app's frame does, and reports what a reader would find wrong: on each slide of
 * a deck, on a page at a laptop's width and a phone's, on a designed document as one sheet and on
 * each of its pages, or on each of a canvas's boards at its own size, with a screenshot of each for
 * the Agent to look at. A sandbox without the agent image's browser skips it; so does
 * a check that fails, which never costs the Agent its publish.
 */
export async function checkLayout(
  input: {
    readonly handle: AgentSandboxHandle
    /** The version's directory in the sandbox. */
    readonly directory: string
    /** The paths the version publishes, relative to the directory: the check serves no others. */
    readonly files: readonly string[]
    /** Names the check's directory, so each version's screenshots stay apart. */
    readonly name: string
    /** The version's `theme.json`, which the reader's frame applies over the app's theme. */
    readonly theme?: ArtifactTheme
    /** The version's queries by name, served where the runtime reads them opened on its own. */
    readonly queries?: Readonly<Record<string, CheckedQuery>>
    readonly signal: AbortSignal
    /** Test seam; production allows 120 seconds. */
    readonly timeoutMs?: number
  } & (
    | {
        readonly layout: FrameLayout
        readonly entry: Uint8Array
        /** A designed document's paper, which its runtime cuts it into pages by. */
        readonly paper?: DocumentPaper
      }
    | {
        readonly layout: "canvas"
        readonly boards: readonly CheckedBoard[]
        /** The canvas's items, for a picture of it as it opens; none without. */
        readonly canvas?: Canvas
      }
  )
): Promise<LayoutCheck> {
  const { sandbox } = input.handle
  const timeoutMs = input.timeoutMs ?? CHECK_TIMEOUT_MS
  const library = contextPath(input.handle, LIBRARY)
  const output = contextPath(input.handle, CHECKS, input.name)
  // Each page to open, with the kit and the runtime as its frame serves them. The sandbox has no
  // way to the API: what the version shows from other artifacts is a placeholder, and what its
  // queries return is read beforehand.
  const pages =
    input.layout === "canvas"
      ? input.boards.map((board) => ({
          path: board.file,
          layout: "page" as const,
          html: board.html,
        }))
      : [
          {
            path: input.layout === "document" ? "document.html" : "index.html",
            layout: input.layout,
            html: input.entry,
          },
        ]
  const paper = input.layout !== "canvas" ? input.paper : undefined
  const entries = pages.map((page) => ({
    path: page.path,
    contents: injectFrameAssets(
      rewriteFrameReferences(new TextDecoder().decode(page.html), [], page.path),
      page.layout,
      page.path,
      paper
    ),
  }))
  await sandbox.writeFiles([
    ...(installed.has(sandbox)
      ? []
      : [
          { path: posix.join(library, "check.cjs"), contents: checkScript },
          { path: posix.join(library, "deck.css"), contents: asset("__sixb/deck.css") },
          { path: posix.join(library, "page.css"), contents: asset("__sixb/page.css") },
          { path: posix.join(library, "document.css"), contents: asset("__sixb/document.css") },
          { path: posix.join(library, "runtime.js"), contents: asset("__sixb/runtime.js") },
          { path: posix.join(library, "probe.js"), contents: `(${layoutProbe.toString()})` },
        ]),
    ...entries.map((entry) => ({
      path: posix.join(output, "entries", entry.path),
      contents: entry.contents,
    })),
    {
      path: posix.join(output, "entries.json"),
      contents: JSON.stringify(
        Object.fromEntries(entries.map((entry) => [entry.path, posix.join("entries", entry.path)]))
      ),
    },
    ...(input.layout === "canvas"
      ? [
          {
            path: posix.join(output, "boards.json"),
            contents: JSON.stringify(
              input.boards.map(({ id, file, w, h }) => ({ id, file, w, h }))
            ),
          },
          ...overviewFiles(output, input.canvas, input.theme),
        ]
      : []),
    { path: posix.join(output, "themes.json"), contents: JSON.stringify(deckThemes(input.theme)) },
    { path: posix.join(output, "files.json"), contents: JSON.stringify(input.files) },
    ...queryFiles(output, input.queries ?? {}),
  ])
  installed.add(sandbox)
  // The check stops itself first, so it reports what it found and closes its browser, which a
  // node killed at the timeout leaves running.
  const deadlineMs = Math.floor((timeoutMs * 5) / 6)
  const result = await sandbox.runCommand(
    "bash",
    loginShellArgs(
      'command -v node >/dev/null 2>&1 || { echo \'{"skipped":"no_node"}\'; exit 0; }; exec node "$SIXB_CHECK/check.cjs" "$SIXB_CHECK_DECK" "$SIXB_CHECK_OUT" "$SIXB_CHECK" "$SIXB_CHECK_DEADLINE_MS" "$SIXB_CHECK_LAYOUT"'
    ),
    {
      env: {
        ...input.handle.env,
        SIXB_CHECK: library,
        SIXB_CHECK_DECK: input.directory,
        SIXB_CHECK_OUT: output,
        SIXB_CHECK_DEADLINE_MS: String(deadlineMs),
        SIXB_CHECK_LAYOUT: input.layout,
      },
      timeout: timeoutMs,
      signal: input.signal,
    }
  )
  input.signal.throwIfAborted()
  // A report counts however the command ended: a check that printed one and then hung on its way
  // out still found what it found.
  const report = parseReport(result.stdout)
  if (report?.skipped) {
    return {
      status: "skipped",
      reason:
        report.skipped === "no_node"
          ? "the sandbox has no Node.js"
          : "the sandbox has no headless browser (the agent image has one)",
    }
  }
  if (!report || report.failed || report.layout !== input.layout) {
    if (result.timedOut) {
      return { status: "skipped", reason: `it took longer than ${timeoutMs / 1000} seconds` }
    }
    const detail = report?.failed ?? result.stderr.trim()
    console.warn(`[SixbAgent] The layout check failed: ${detail.slice(0, 500)}`)
    return { status: "skipped", reason: "the check failed in the sandbox" }
  }
  const noun = { deck: "deck", page: "page", document: "document", canvas: "canvas" }[input.layout]
  const reached = { deck: "Slides", page: "Widths", document: "Pages", canvas: "Boards" }[
    input.layout
  ]
  const checks = posix.join(input.handle.contextDirectory, CHECKS, input.name)
  const named = (path: string) => posix.join(checks, posix.relative(output, path))
  const screenshots = (report.screenshots ?? []).map(named)
  return {
    status: "checked",
    screenshots,
    ...(report.pages ? { pages: report.pages } : {}),
    ...(report.overview ? { overview: named(report.overview) } : {}),
    warnings: [
      ...layoutWarnings(
        report.problems ?? [],
        input.layout === "document" ? "document" : undefined
      ),
      ...oversizedWarnings(report.oversized ?? []),
      ...(report.stalls ?? []).map(({ board, message }) => ({
        code: "layout_incomplete",
        part: board,
        message: `Board '${board}' stopped answering: ${message.slice(0, 200)}. The check went on without it.`,
      })),
      ...(report.errors ?? []).map((error) => ({
        code: "layout_load_error",
        message: `While the ${noun} loaded: ${error.slice(0, 200)}.`,
      })),
      ...(report.stopped === undefined
        ? []
        : [
            {
              code: "layout_incomplete",
              message: `The check stopped early: ${report.stopped.slice(0, 200)}. ${reached} it did not reach were not checked.`,
            },
          ]),
    ],
  }
}

/**
 * Each query's answer as `queries/<name>.json`, and `queries.json`, the status each is served
 * with: a failed query answers with its error, which the runtime rejects the page's promise with.
 */
function queryFiles(
  output: string,
  queries: Readonly<Record<string, CheckedQuery>>
): { path: string; contents: string }[] {
  const entries = Object.entries(queries)
  return [
    ...entries.map(([name, query]) => ({
      path: posix.join(output, "queries", `${name}.json`),
      contents: JSON.stringify("error" in query ? { error: query.error } : query.result),
    })),
    {
      path: posix.join(output, "queries.json"),
      contents: JSON.stringify(
        Object.fromEntries(entries.map(([name, query]) => [name, "error" in query ? 409 : 200]))
      ),
    },
  ]
}

/**
 * The themes a reader sees the deck in: Sixb's light and dark, or only the mode its `theme.json`
 * pins, each with the deck's tokens over Sixb's.
 */
function deckThemes(theme: ArtifactTheme | undefined) {
  return Object.fromEntries(
    artifactThemeModes(theme).map((mode) => {
      const base = FRAME_DEFAULT_THEMES[mode]
      return [mode, { ...base, tokens: { ...base.tokens, ...theme?.tokens } }]
    })
  )
}

/**
 * A canvas's page of itself as it opens, in the first theme the reader sees it in, each board
 * the screenshot the check takes of it, and the window to screenshot it in.
 */
function overviewFiles(
  output: string,
  canvas: Canvas | undefined,
  theme: ArtifactTheme | undefined
): { path: string; contents: string }[] {
  if (!canvas) return []

  const [mode = "light"] = artifactThemeModes(theme)
  const tokens = { ...FRAME_DEFAULT_THEMES[mode].tokens, ...theme?.tokens }
  return [
    {
      path: posix.join(output, "overview.html"),
      contents: canvasOverviewHtml({ canvas, tokens, image: (id) => `boards/${id}.png` }),
    },
    { path: posix.join(output, "overview.json"), contents: JSON.stringify(OVERVIEW_VIEWPORT) },
  ]
}

function asset(path: string): string {
  const file = FRAME_ASSETS[path]
  if (!file) throw new Error(`[SixbAgent] The frame has no '${path}'.`)
  return file.body
}

function parseReport(stdout: string): CheckReport | null {
  const line = stdout.trim().split("\n").at(-1)
  if (!line) return null
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === "object" && value !== null ? (value as CheckReport) : null
  } catch {
    return null
  }
}

/** A board whose page draws larger than the board, in CSS pixels. */
interface OversizedBoard {
  readonly board: string
  readonly w: number
  readonly h: number
  readonly page: { readonly w: number; readonly h: number }
}

/**
 * Each board whose page is larger than the board: the canvas, its preview, and the opened board
 * all show only its top left. The board takes the page's size; the canvas's zoom makes it small.
 */
export function oversizedWarnings(boards: readonly OversizedBoard[]): LayoutWarning[] {
  const warnings: LayoutWarning[] = boards.slice(0, MAX_WARNINGS).map(({ board, w, h, page }) => ({
    code: "layout_board_too_small",
    part: board,
    message: `Board '${board}' is ${w}×${h} but its page draws ${page.w}×${page.h}, so the canvas, its preview and the opened board show only its top left. Set its "w" and "h" in canvas.json to ${Math.max(w, page.w)} and ${Math.max(h, page.h)}: the canvas's zoom draws it small, never a smaller board.`,
  }))
  const more = boards.length - warnings.length
  if (more > 0) {
    warnings.push({
      code: "layout_board_too_small",
      message: `${more} more board${more === 1 ? "" : "s"} draw a page larger than the board; give each board its page's size.`,
    })
  }
  return warnings
}

/** The most a check reports; the screenshots show the rest. */
const MAX_WARNINGS = 12
const SEVERITY: readonly LayoutProblem["code"][] = [
  "broken_image",
  "outside",
  "wide",
  "footer",
  "overlap",
  "clipped",
  "contrast",
  "small_target",
  "small_text",
]
const VIEWS: readonly PageView[] = ["desktop", "phone"]

/**
 * A problem where the check found it: on a deck's slide, on a page at one width, on a designed
 * document's page, or on a designed document as one sheet, at its paper's width, which names none
 * of them, or on a phone.
 */
type CheckedProblem = LayoutProblem & {
  readonly theme: "light" | "dark"
  readonly slide?: number
  /** A designed document's page. */
  readonly page?: number
  readonly view?: PageView
  /** The canvas's board it is on. */
  readonly board?: string
}

/**
 * The problems as warnings, worst first. A layout break is one warning per element; small text,
 * a small control, and low contrast with one cause, the same element at the same size or in the
 * same colors, is one warning naming every slide or width it is at, so a deck's eyebrow at 17px
 * is one line, not nine. Contrast says which theme it fails in when it fails in one.
 */
export function layoutWarnings(
  problems: readonly CheckedProblem[],
  /** What was checked when it is a designed document, whose problems at a width are its own. */
  checked?: "document"
): LayoutWarning[] {
  const groups = new Map<
    string,
    {
      problem: CheckedProblem
      slides: Set<number>
      pages: Set<number>
      views: Set<PageView>
      boards: Set<string>
      /** Whether it is on a designed document's sheet, at its paper's width: everywhere it shows. */
      sheet: boolean
      texts: Set<string>
      themes: Set<string>
    }
  >()
  for (const problem of problems) {
    const at =
      problem.slide ?? (problem.page && `page ${problem.page}`) ?? problem.view ?? problem.board
    const cause =
      problem.code === "small_text" || problem.code === "small_target"
        ? `${problem.selector}|${problem.size}`
        : problem.code === "contrast"
          ? `${problem.selector}|${problem.colors?.join("|")}`
          : `${at}|${problem.selector}|${problem.text}|${problem.rect.x},${problem.rect.y}`
    const key = `${problem.code}|${cause}`
    const group = groups.get(key) ?? {
      problem,
      slides: new Set(),
      pages: new Set(),
      views: new Set(),
      boards: new Set(),
      sheet: false,
      texts: new Set(),
      themes: new Set(),
    }
    if (problem.slide !== undefined) group.slides.add(problem.slide)
    if (problem.page !== undefined) group.pages.add(problem.page)
    if (problem.view) group.views.add(problem.view)
    if (problem.board) group.boards.add(problem.board)
    if (at === undefined) group.sheet = true
    group.texts.add(problem.text)
    group.themes.add(problem.theme)
    groups.set(key, group)
  }
  // Boards in the order the check met them, as the canvas lists them.
  const boardOrder = [
    ...new Set(problems.flatMap((problem) => (problem.board ? [problem.board] : []))),
  ]
  const first = (group: {
    slides: Set<number>
    pages: Set<number>
    views: Set<PageView>
    boards: Set<string>
  }) =>
    group.slides.size > 0
      ? Math.min(...group.slides)
      : group.pages.size > 0
        ? Math.min(...group.pages)
        : group.boards.size > 0
          ? Math.min(...[...group.boards].map((board) => boardOrder.indexOf(board)))
          : group.views.size > 0
            ? Math.min(...[...group.views].map((view) => VIEWS.indexOf(view)))
            : 0
  const ordered = [...groups.values()].sort(
    (a, b) =>
      SEVERITY.indexOf(a.problem.code) - SEVERITY.indexOf(b.problem.code) || first(a) - first(b)
  )
  const warnings: LayoutWarning[] = ordered
    .slice(0, MAX_WARNINGS)
    .map(({ problem, slides, pages, views, boards, sheet, texts, themes }) => {
      const theme =
        problem.code === "contrast" && themes.size === 1 ? ` in ${[...themes][0]} mode` : ""
      const onBoards = boardOrder.filter((board) => boards.has(board))
      // A designed document's problem names its pages, a phone, or, found on its sheet, nothing.
      const place: Place =
        slides.size > 0
          ? "slide"
          : checked !== "document" && (boards.size > 0 || views.size > 0)
            ? "page"
            : "document"
      const where =
        onBoards.length > 0
          ? boardList(onBoards)
          : slides.size > 0
            ? slideList([...slides])
            : pages.size > 0
              ? numberedList("Page", [...pages])
              : views.size > 0 && !sheet
                ? viewList([...views])
                : "In the document"
      const part =
        onBoards[0] ??
        (slides.size > 0
          ? String(Math.min(...slides))
          : pages.size > 0
            ? `page ${Math.min(...pages)}`
            : views.size > 0 && !sheet
              ? (VIEWS.find((view) => views.has(view)) ?? "desktop")
              : undefined)
      return {
        code: `layout_${problem.code}`,
        ...(part ? { part } : {}),
        message: `${where}: ${describeProblem(problem, [...texts], place)}${theme}.`,
      }
    })
  const more = ordered.length - warnings.length
  if (more > 0) {
    warnings.push({
      code: "layout_more",
      message: `${more} more layout problem${more === 1 ? "" : "s"}; the screenshots show them.`,
    })
  }
  return warnings
}

/** `Board 'region'`, `Boards 'welcome' and 'region'`. */
function boardList(boards: readonly string[]): string {
  const named = boards.map((board) => `'${board}'`)
  if (named.length === 1) return `Board ${named[0]}`
  return `Boards ${named.slice(0, -1).join(", ")} and ${named.at(-1)}`
}

/** `Slide 3`, `Slides 1–4 and 7`. */
function slideList(slides: number[]): string {
  return numberedList("Slide", slides)
}

/** `Page 3`, `Pages 1–4 and 7`: what `noun` names, by number. */
function numberedList(noun: string, numbers: number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b)
  const runs: string[] = []
  for (let index = 0; index < sorted.length; ) {
    let end = index
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] ?? 0) + 1) end++
    runs.push(end > index ? `${sorted[index]}–${sorted[end]}` : String(sorted[index]))
    index = end + 1
  }
  const label = runs.length > 1 ? `${runs.slice(0, -1).join(", ")} and ${runs.at(-1)}` : runs[0]
  return `${sorted.length === 1 ? noun : `${noun}s`} ${label}`
}

/** `On a phone (390px)`, `At 1280px and on a phone`. */
function viewList(views: PageView[]): string {
  if (views.length > 1) return "At 1280px and on a phone (390px)"
  return views[0] === "phone" ? "On a phone (390px)" : "At 1280px"
}

/** Where a problem is: on a slide, on a web page, or in a designed document. */
type Place = "slide" | "page" | "document"

function describeProblem(problem: CheckedProblem, texts: readonly string[], place: Place): string {
  const { x, y, width, height } = problem.rect
  const where = `at ${x},${y} (${width}×${height})`
  const quoted = texts
    .slice(0, 2)
    .map((text) => `“${text}”`)
    .join(", ")
  const what = `${problem.selector} ${quoted}${texts.length > 2 ? ` and ${texts.length - 2} more` : ""}`
  switch (problem.code) {
    case "outside":
      return place === "document"
        ? `${what} runs past the page's edge ${where}, which cuts it off; let it wrap or shrink, or give it a page of its own`
        : `${what} runs past the slide's edge ${where}, which cuts it off`
    case "footer":
      return `${what} runs into the footer ${where}; keep content above the source line`
    case "wide":
      if (place === "document" && problem.view === "phone") {
        return `${what} runs past the screen's right edge ${where}, so the document scrolls sideways; let it wrap, or stack it in an @media screen and (max-width: 600px) rule`
      }
      if (place === "document") {
        return `${what} runs past the sheet's right edge ${where}, past where it can print; let it wrap or shrink`
      }
      return `${what} runs past the screen's right edge ${where}, so the whole page scrolls sideways; let it wrap or shrink, or put it in a box that scrolls (.table-scroll)`
    case "overlap":
      return `${what} is drawn over “${problem.other}” ${where}`
    case "clipped":
      return `${what} is cut off by its own box ${where}`
    case "small_text":
      return place !== "slide"
        ? `${what} ${texts.length === 1 ? "is" : "are"} ${problem.size}px; nothing on a page may be under 12px`
        : `${what} ${texts.length === 1 ? "is" : "are"} ${problem.size}px; nothing on a slide may be under 18px`
    case "small_target":
      return `${what} ${texts.length === 1 ? "is" : "are"} ${problem.size}px across; make each control at least 24px each way`
    case "contrast":
      return `${what} ${texts.length === 1 ? "has" : "have"} a contrast of ${problem.ratio}:1 (${problem.colors?.join(" on ")}), under WCAG AA`
    case "broken_image":
      return `the image ${quoted} did not load ${where}`
  }
}
