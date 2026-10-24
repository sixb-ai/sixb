import { posix } from "node:path"
import type { Sandbox } from "@sixb/core"
import type { ArtifactTheme } from "@sixb/core/artifacts"
import {
  FRAME_ASSETS,
  FRAME_DEFAULT_THEMES,
  type FrameLayout,
  injectFrameAssets,
  type LayoutProblem,
  layoutProbe,
  rewriteFrameReferences,
} from "@sixb/core/internal/artifacts/frames"
import type { AgentSandboxHandle } from "../../sandbox-handle"
import checkScript from "./check.cjs" with { type: "text" }

const LIBRARY = ".sixb/agent/lib/layout-check"
const CHECKS = ".sixb/agent/checks"
/** Chromium's start, a deck's fonts, and two passes over up to 100 slides, or a page at two widths. */
const CHECK_TIMEOUT_MS = 120_000
/**
 * Sandboxes the check's library is written in. `.sixb/agent` lasts the run, and each run has its
 * own sandbox object, a lasting sandbox's included, so the library is written once per run.
 */
const installed = new WeakSet<Sandbox>()

/** What the layout check found, for the publish tool to report beside the version. */
export type LayoutCheck =
  | {
      readonly status: "checked"
      readonly warnings: readonly LayoutWarning[]
      /** One per slide, or a page's at each width, relative to the sandbox's working directory. */
      readonly screenshots: readonly string[]
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
  readonly problems?: readonly CheckedProblem[]
  readonly errors?: readonly string[]
  readonly screenshots?: readonly string[]
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
export type CheckedQuery = { readonly result: unknown } | { readonly error: string }

/** A width a page is checked at, as a laptop and a phone show it. */
export type PageView = "desktop" | "phone"

/**
 * Lays a published deck, page, or canvas out in the sandbox's headless Chromium, as the app's
 * frame does, and reports what a reader would find wrong: on each slide of a deck, on a page at a
 * laptop's width and a phone's, or on each of a canvas's boards at its own size, with a screenshot
 * of each for the Agent to look at. A sandbox without the agent image's browser skips it; so does
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
    | { readonly layout: FrameLayout; readonly entry: Uint8Array }
    | { readonly layout: "canvas"; readonly boards: readonly CheckedBoard[] }
  )
): Promise<LayoutCheck> {
  const { sandbox } = input.handle
  const timeoutMs = input.timeoutMs ?? CHECK_TIMEOUT_MS
  const library = posix.join(sandbox.workingDirectory, LIBRARY)
  const output = posix.join(sandbox.workingDirectory, CHECKS, input.name)
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
      : [{ path: "index.html", layout: input.layout, html: input.entry }]
  const entries = pages.map((page) => ({
    path: page.path,
    contents: injectFrameAssets(
      rewriteFrameReferences(new TextDecoder().decode(page.html), [], page.path),
      page.layout,
      page.path
    ),
  }))
  await sandbox.writeFiles([
    ...(installed.has(sandbox)
      ? []
      : [
          { path: posix.join(library, "check.cjs"), contents: checkScript },
          { path: posix.join(library, "deck.css"), contents: asset("__sixb/deck.css") },
          { path: posix.join(library, "page.css"), contents: asset("__sixb/page.css") },
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
    [
      "-lc",
      'command -v node >/dev/null 2>&1 || { echo \'{"skipped":"no_node"}\'; exit 0; }; exec node "$SIXB_CHECK/check.cjs" "$SIXB_CHECK_DECK" "$SIXB_CHECK_OUT" "$SIXB_CHECK" "$SIXB_CHECK_DEADLINE_MS" "$SIXB_CHECK_LAYOUT"',
    ],
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
    console.warn(`[SixbAgentWorker] The layout check failed: ${detail.slice(0, 500)}`)
    return { status: "skipped", reason: "the check failed in the sandbox" }
  }
  const noun = { deck: "deck", page: "page", canvas: "canvas" }[input.layout]
  const reached = { deck: "Slides", page: "Widths", canvas: "Boards" }[input.layout]
  const relative = (path: string) => posix.relative(sandbox.workingDirectory, path)
  const screenshots = (report.screenshots ?? []).map(relative)
  return {
    status: "checked",
    screenshots,
    warnings: [
      ...layoutWarnings(report.problems ?? []),
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
  const modes = theme?.mode ? [theme.mode] : (["light", "dark"] as const)
  return Object.fromEntries(
    modes.map((mode) => {
      const base = FRAME_DEFAULT_THEMES[mode]
      return [mode, { ...base, tokens: { ...base.tokens, ...theme?.tokens } }]
    })
  )
}

function asset(path: string): string {
  const file = FRAME_ASSETS[path]
  if (!file) throw new Error(`[SixbAgentWorker] The frame has no '${path}'.`)
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

/** A problem where the check found it: on a deck's slide, or on a page at one width. */
type CheckedProblem = LayoutProblem & {
  readonly theme: "light" | "dark"
  readonly slide?: number
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
export function layoutWarnings(problems: readonly CheckedProblem[]): LayoutWarning[] {
  const groups = new Map<
    string,
    {
      problem: CheckedProblem
      slides: Set<number>
      views: Set<PageView>
      boards: Set<string>
      texts: Set<string>
      themes: Set<string>
    }
  >()
  for (const problem of problems) {
    const at = problem.slide ?? problem.view ?? problem.board
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
      views: new Set(),
      boards: new Set(),
      texts: new Set(),
      themes: new Set(),
    }
    if (problem.slide !== undefined) group.slides.add(problem.slide)
    if (problem.view) group.views.add(problem.view)
    if (problem.board) group.boards.add(problem.board)
    group.texts.add(problem.text)
    group.themes.add(problem.theme)
    groups.set(key, group)
  }
  // Boards in the order the check met them, as the canvas lists them.
  const boardOrder = [
    ...new Set(problems.flatMap((problem) => (problem.board ? [problem.board] : []))),
  ]
  const first = (group: { slides: Set<number>; views: Set<PageView>; boards: Set<string> }) =>
    group.slides.size > 0
      ? Math.min(...group.slides)
      : group.boards.size > 0
        ? Math.min(...[...group.boards].map((board) => boardOrder.indexOf(board)))
        : Math.min(...[...group.views].map((view) => VIEWS.indexOf(view)))
  const ordered = [...groups.values()].sort(
    (a, b) =>
      SEVERITY.indexOf(a.problem.code) - SEVERITY.indexOf(b.problem.code) || first(a) - first(b)
  )
  const warnings: LayoutWarning[] = ordered
    .slice(0, MAX_WARNINGS)
    .map(({ problem, slides, views, boards, texts, themes }) => {
      const theme =
        problem.code === "contrast" && themes.size === 1 ? ` in ${[...themes][0]} mode` : ""
      const page = slides.size === 0
      const onBoards = boardOrder.filter((board) => boards.has(board))
      const where =
        onBoards.length > 0
          ? boardList(onBoards)
          : page
            ? viewList([...views])
            : slideList([...slides])
      return {
        code: `layout_${problem.code}`,
        part:
          onBoards[0] ??
          (page
            ? (VIEWS.find((view) => views.has(view)) ?? "desktop")
            : String(Math.min(...slides))),
        message: `${where}: ${describeProblem(problem, [...texts], page)}${theme}.`,
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
  const sorted = [...slides].sort((a, b) => a - b)
  const runs: string[] = []
  for (let index = 0; index < sorted.length; ) {
    let end = index
    while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] ?? 0) + 1) end++
    runs.push(end > index ? `${sorted[index]}–${sorted[end]}` : String(sorted[index]))
    index = end + 1
  }
  const label = runs.length > 1 ? `${runs.slice(0, -1).join(", ")} and ${runs.at(-1)}` : runs[0]
  return `${sorted.length === 1 ? "Slide" : "Slides"} ${label}`
}

/** `On a phone (390px)`, `At 1280px and on a phone`. */
function viewList(views: PageView[]): string {
  if (views.length > 1) return "At 1280px and on a phone (390px)"
  return views[0] === "phone" ? "On a phone (390px)" : "At 1280px"
}

function describeProblem(problem: LayoutProblem, texts: readonly string[], page: boolean): string {
  const { x, y, width, height } = problem.rect
  const where = `at ${x},${y} (${width}×${height})`
  const quoted = texts
    .slice(0, 2)
    .map((text) => `“${text}”`)
    .join(", ")
  const what = `${problem.selector} ${quoted}${texts.length > 2 ? ` and ${texts.length - 2} more` : ""}`
  switch (problem.code) {
    case "outside":
      return `${what} runs past the slide's edge ${where}, which cuts it off`
    case "footer":
      return `${what} runs into the footer ${where}; keep content above the source line`
    case "wide":
      return `${what} runs past the screen's right edge ${where}, so the whole page scrolls sideways; let it wrap or shrink, or put it in a box that scrolls (.table-scroll)`
    case "overlap":
      return `${what} is drawn over “${problem.other}” ${where}`
    case "clipped":
      return `${what} is cut off by its own box ${where}`
    case "small_text":
      return page
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
