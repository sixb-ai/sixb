import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  SIXB_AUTHORIZATION_ERROR_CODES,
  SIXB_CONFLICT_ERROR_CODES,
  SIXB_ERROR_CODES,
  SIXB_ERROR_RETRYABLE,
  SIXB_PROVIDER_ERROR_CODES,
  SIXB_TIMEOUT_ERROR_CODES,
  SIXB_VALIDATION_ERROR_CODES,
  type SixbErrorCode,
  type SixbErrorKind,
} from "../../packages/core/src/errors"

/**
 * `SixbErrorCode` is a contract with people, not just with the compiler: the code is what an
 * operator reads in Atlas and what an app author branches on, and neither can act on a code that
 * is nowhere explained. An undocumented code is therefore a defect, and so is a documented one
 * that no longer exists — a table row for a code Sixb cannot raise sends the reader looking for a
 * failure that will never arrive.
 *
 * To see the teeth — each was run and watched to fail before this landed: add a code to
 * `SIXB_ERROR_CODES` without a row (fails "documents every code"), add a row for a code that does
 * not exist (fails "documents only real codes"), flip one `retryable` on either side (fails
 * "agrees with SIXB_ERROR_RETRYABLE"), swap two rows (fails "lists codes in the same order"), or
 * add one code to a second class tuple (fails "claim no code twice" and "list codes the same way
 * the docs do").
 */

const repoRoot = resolve(import.meta.dir, "..", "..")
const docPath = join(repoRoot, "docs", "runtime", "error-codes.md")
const doc = readFileSync(docPath, "utf8")

const CODES_HEADING = "\n## The codes\n"
const THIRD_PARTY_HEADING = "\n## Third-party providers\n"

interface DocumentedCode {
  readonly code: string
  readonly retryable: boolean
  readonly description: string
}

const documented = parseCodeRows(sectionBetween(doc, CODES_HEADING, THIRD_PARTY_HEADING))

describe("docs/runtime/error-codes.md", () => {
  test("documents every code", () => {
    const rows = new Set(documented.map((row) => row.code))
    const missing = SIXB_ERROR_CODES.filter((code) => !rows.has(code))
    expect(missing).toEqual([])
  })

  test("documents only real codes", () => {
    const codes = new Set<string>(SIXB_ERROR_CODES)
    const unknown = documented.map((row) => row.code).filter((code) => !codes.has(code))
    expect(unknown).toEqual([])
  })

  test("documents each code once", () => {
    const counts = new Map<string, number>()
    for (const row of documented) counts.set(row.code, (counts.get(row.code) ?? 0) + 1)
    const duplicates = [...counts].filter(([, count]) => count > 1).map(([code]) => code)
    expect(duplicates).toEqual([])
  })

  test("lists codes in the same order as SIXB_ERROR_CODES", () => {
    expect(documented.map((row) => row.code)).toEqual([...SIXB_ERROR_CODES])
  })

  test("agrees with SIXB_ERROR_RETRYABLE", () => {
    const disagreements = documented
      .filter((row) => isKnownCode(row.code) && SIXB_ERROR_RETRYABLE[row.code] !== row.retryable)
      .map((row) => `${row.code}: doc says ${row.retryable}`)
    expect(disagreements).toEqual([])
  })

  test("explains what raises each code", () => {
    const thin = documented.filter((row) => row.description.length < 20).map((row) => row.code)
    expect(thin).toEqual([])
  })
})

describe("the error kinds", () => {
  const kinds = {
    validation: SIXB_VALIDATION_ERROR_CODES,
    authorization: SIXB_AUTHORIZATION_ERROR_CODES,
    conflict: SIXB_CONFLICT_ERROR_CODES,
    timeout: SIXB_TIMEOUT_ERROR_CODES,
    provider: SIXB_PROVIDER_ERROR_CODES,
  } as const satisfies Record<SixbErrorKind, readonly SixbErrorCode[]>

  const kindTable = parseKindRows(sectionBetween(doc, "\n## Catching\n", "\n## Retryable\n"))

  test("claim no code twice", () => {
    const owner = new Map<string, string>()
    const overlaps: string[] = []
    for (const [kind, codes] of Object.entries(kinds)) {
      for (const code of codes) {
        const previous = owner.get(code)
        if (previous) overlaps.push(`${code}: ${previous} and ${kind}`)
        else owner.set(code, kind)
      }
    }
    expect(overlaps).toEqual([])
  })

  test("list codes the same way the docs do", () => {
    for (const [kind, codes] of Object.entries(kinds)) {
      expect({ [kind]: kindTable.get(kind) }).toEqual({ [kind]: [...codes] })
    }
  })

  test("are all documented", () => {
    expect([...kindTable.keys()].sort()).toEqual(Object.keys(kinds).sort())
  })
})

function isKnownCode(code: string): code is SixbErrorCode {
  return (SIXB_ERROR_CODES as readonly string[]).includes(code)
}

function sectionBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from)
  const end = source.indexOf(to, start + from.length)
  if (start === -1 || end === -1) {
    throw new Error(
      `[docs] error-codes.md is missing the '${from.trim()}' or '${to.trim()}' section`
    )
  }
  return source.slice(start + from.length, end)
}

/** `| \`code\` | yes | Raised when ... |` — the retryable column is what identifies a code row. */
function parseCodeRows(section: string): readonly DocumentedCode[] {
  const rows: DocumentedCode[] = []
  for (const cells of tableRows(section)) {
    if (cells.length !== 3) continue
    const code = unwrapCode(cells[0])
    if (!code || (cells[1] !== "yes" && cells[1] !== "no")) continue
    rows.push({ code, retryable: cells[1] === "yes", description: cells[2] })
  }
  return rows
}

/** `| \`conflict\` | means ... | \`code\`, \`code\` |` — a kind row is one whose codes are all known. */
function parseKindRows(section: string): ReadonlyMap<string, readonly string[]> {
  const rows = new Map<string, readonly string[]>()
  for (const cells of tableRows(section)) {
    if (cells.length !== 3) continue
    const kind = unwrapCode(cells[0])
    const codes = [...cells[2].matchAll(/`([^`]+)`/g)].map((match) => match[1])
    if (!kind || codes.length === 0 || !codes.every(isKnownCode)) continue
    rows.set(kind, codes)
  }
  return rows
}

function tableRows(section: string): readonly (readonly string[])[] {
  return section
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[\s-]+\|/.test(line))
    .map((line) =>
      line
        .slice(1, line.endsWith("|") ? -1 : undefined)
        .split("|")
        .map((cell) => cell.trim())
    )
}

function unwrapCode(cell: string): string | undefined {
  const match = /^`([^`]+)`$/.exec(cell)
  return match?.[1]
}
