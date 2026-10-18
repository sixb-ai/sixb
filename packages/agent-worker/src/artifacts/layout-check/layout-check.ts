import { posix } from "node:path"
import type { Sandbox } from "@sixb/core"
import type { ArtifactTheme } from "@sixb/core/artifacts"
import {
  FRAME_ASSETS,
  FRAME_DEFAULT_THEMES,
  injectFrameAssets,
  type LayoutProblem,
  layoutProbe,
  rewriteFrameReferences,
} from "@sixb/core/internal/artifacts/frames"
import type { AgentSandboxHandle } from "../../sandbox-handle"
import checkScript from "./check.cjs" with { type: "text" }

const LIBRARY = ".sixb/agent/lib/layout-check"
const CHECKS = ".sixb/agent/checks"
/** Chromium's start, a deck's fonts, and two passes over up to 100 slides. */
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
      /** One per slide, relative to the sandbox's working directory. */
      readonly screenshots: readonly string[]
    }
  | { readonly status: "skipped"; readonly reason: string }

export interface LayoutWarning {
  readonly code: string
  readonly message: string
  /** The slide's number; none for the deck as a whole. */
  readonly part?: string
}

interface CheckReport {
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
 * Lays a published deck out in the sandbox's headless Chromium, as the app's frame does, and
 * reports what a reader would find wrong with each slide, with a screenshot of each for the Agent
 * to look at. A sandbox without the agent image's browser skips it; so does a check that fails,
 * which never costs the Agent its publish.
 */
export async function checkDeckLayout(input: {
  readonly handle: AgentSandboxHandle
  /** The deck's directory in the sandbox. */
  readonly directory: string
  /** The paths the version publishes, relative to the directory: the check serves no others. */
  readonly files: readonly string[]
  readonly entry: Uint8Array
  /** Names the check's directory, so each version's screenshots stay apart. */
  readonly name: string
  /** The deck's `theme.json`, which the reader's frame applies over the app's theme. */
  readonly theme?: ArtifactTheme
  readonly signal: AbortSignal
  /** Test seam; production allows 120 seconds. */
  readonly timeoutMs?: number
}): Promise<LayoutCheck> {
  const { sandbox } = input.handle
  const timeoutMs = input.timeoutMs ?? CHECK_TIMEOUT_MS
  const library = posix.join(sandbox.workingDirectory, LIBRARY)
  const output = posix.join(sandbox.workingDirectory, CHECKS, input.name)
  // The sandbox has no way to the API: what the deck shows from other artifacts is a placeholder.
  const entry = await injectFrameAssets(
    await rewriteFrameReferences(new TextDecoder().decode(input.entry), [])
  )
  await sandbox.writeFiles([
    ...(installed.has(sandbox)
      ? []
      : [
          { path: posix.join(library, "check.cjs"), contents: checkScript },
          { path: posix.join(library, "kit.css"), contents: asset("__sixb/kit.css") },
          { path: posix.join(library, "runtime.js"), contents: asset("__sixb/runtime.js") },
          { path: posix.join(library, "probe.js"), contents: `(${layoutProbe.toString()})` },
        ]),
    { path: posix.join(output, "entry.html"), contents: entry },
    { path: posix.join(output, "themes.json"), contents: JSON.stringify(deckThemes(input.theme)) },
    { path: posix.join(output, "files.json"), contents: JSON.stringify(input.files) },
  ])
  installed.add(sandbox)
  // The check stops itself first, so it reports what it found and closes its browser, which a
  // node killed at the timeout leaves running.
  const deadlineMs = Math.floor((timeoutMs * 5) / 6)
  const result = await sandbox.runCommand(
    "bash",
    [
      "-lc",
      'command -v node >/dev/null 2>&1 || { echo \'{"skipped":"no_node"}\'; exit 0; }; exec node "$SIXB_CHECK/check.cjs" "$SIXB_CHECK_DECK" "$SIXB_CHECK_OUT" "$SIXB_CHECK" "$SIXB_CHECK_DEADLINE_MS"',
    ],
    {
      env: {
        ...input.handle.env,
        SIXB_CHECK: library,
        SIXB_CHECK_DECK: input.directory,
        SIXB_CHECK_OUT: output,
        SIXB_CHECK_DEADLINE_MS: String(deadlineMs),
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
  if (!report || report.failed || report.slides === undefined) {
    if (result.timedOut) {
      return { status: "skipped", reason: `it took longer than ${timeoutMs / 1000} seconds` }
    }
    const detail = report?.failed ?? result.stderr.trim()
    console.warn(`[SixbAgentWorker] The layout check failed: ${detail.slice(0, 500)}`)
    return { status: "skipped", reason: "the check failed in the sandbox" }
  }
  const relative = (path: string) => posix.relative(sandbox.workingDirectory, path)
  const screenshots = (report.screenshots ?? []).map(relative)
  return {
    status: "checked",
    screenshots,
    warnings: [
      ...layoutWarnings(report.problems ?? []),
      ...(report.errors ?? []).map((error) => ({
        code: "layout_load_error",
        message: `While the deck loaded: ${error.slice(0, 200)}.`,
      })),
      ...(report.stopped === undefined
        ? []
        : [
            {
              code: "layout_incomplete",
              message: `The check stopped early: ${report.stopped.slice(0, 200)}. Slides it did not reach were not checked.`,
            },
          ]),
    ],
  }
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
  "footer",
  "overlap",
  "clipped",
  "contrast",
  "small_text",
]

type CheckedProblem = LayoutProblem & { slide: number; theme: "light" | "dark" }

/**
 * The problems as warnings, worst first. A layout break is one warning per element; small text
 * and low contrast with one cause, the same element at the same size or in the same colors, is
 * one warning naming every slide it is on, so a deck's eyebrow at 17px is one line, not nine.
 * Contrast says which theme it fails in when it fails in one.
 */
export function layoutWarnings(problems: readonly CheckedProblem[]): LayoutWarning[] {
  const groups = new Map<
    string,
    { problem: CheckedProblem; slides: Set<number>; texts: Set<string>; themes: Set<string> }
  >()
  for (const problem of problems) {
    const cause =
      problem.code === "small_text"
        ? `${problem.selector}|${problem.size}`
        : problem.code === "contrast"
          ? `${problem.selector}|${problem.colors?.join("|")}`
          : `${problem.slide}|${problem.selector}|${problem.text}|${problem.rect.x},${problem.rect.y}`
    const key = `${problem.code}|${cause}`
    const group = groups.get(key) ?? {
      problem,
      slides: new Set(),
      texts: new Set(),
      themes: new Set(),
    }
    group.slides.add(problem.slide)
    group.texts.add(problem.text)
    group.themes.add(problem.theme)
    groups.set(key, group)
  }
  const ordered = [...groups.values()].sort(
    (a, b) =>
      SEVERITY.indexOf(a.problem.code) - SEVERITY.indexOf(b.problem.code) ||
      Math.min(...a.slides) - Math.min(...b.slides)
  )
  const warnings: LayoutWarning[] = ordered
    .slice(0, MAX_WARNINGS)
    .map(({ problem, slides, texts, themes }) => {
      const theme =
        problem.code === "contrast" && themes.size === 1 ? ` in ${[...themes][0]} mode` : ""
      return {
        code: `layout_${problem.code}`,
        part: String(Math.min(...slides)),
        message: `${slideList([...slides])}: ${describeProblem(problem, [...texts])}${theme}.`,
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

function describeProblem(problem: LayoutProblem, texts: readonly string[]): string {
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
    case "overlap":
      return `${what} is drawn over “${problem.other}” ${where}`
    case "clipped":
      return `${what} is cut off by its own box ${where}`
    case "small_text":
      return `${what} ${texts.length === 1 ? "is" : "are"} ${problem.size}px; nothing on a slide may be under 18px`
    case "contrast":
      return `${what} ${texts.length === 1 ? "has" : "have"} a contrast of ${problem.ratio}:1 (${problem.colors?.join(" on ")}), under WCAG AA`
    case "broken_image":
      return `the image ${quoted} did not load ${where}`
  }
}
