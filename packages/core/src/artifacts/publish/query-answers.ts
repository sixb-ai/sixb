import { AuthorizationError } from "../../authorization/errors"
import { ObjectQueryExecutionError } from "../../objects/query/errors"
import type { ArtifactVersionRecord } from "../../storage/artifacts/types"
import { ArtifactRequestError } from "../errors"
import { type ArtifactQueryResult, artifactQueryName, isArtifactQueryName } from "../queries"
import { serializeArtifactQueryResult } from "../serialize-query"

// A page opened outside the app, by the Agent's layout check or to picture a canvas's boards, reads
// its queries from answers read beforehand: each as the query route serves it to whoever read it,
// or why it failed for them, which the page's `sixb.query` rejects with.

/** What `sixb.query(name)` reads in a page opened outside the app. */
export type ArtifactQueryAnswer = { readonly result: unknown } | { readonly error: string }

/** A version's query answers by name. */
export type ArtifactQueryAnswers = Readonly<Record<string, ArtifactQueryAnswer>>

/**
 * One query's answer, as `read` reads it: its result serialized as the route serves it, or a
 * refusal in the words the API gives a reader. Any other failure stays internal.
 */
export async function answerArtifactQuery(
  read: () => Promise<ArtifactQueryResult | null>
): Promise<ArtifactQueryAnswer> {
  try {
    const result = await read()
    if (!result) return { error: UNREADABLE }

    return { result: serializeArtifactQueryResult(result) }
  } catch (error) {
    if (
      error instanceof ArtifactRequestError ||
      error instanceof AuthorizationError ||
      error instanceof ObjectQueryExecutionError
    ) {
      return { error: /[.!?]$/.test(error.message) ? error.message : `${error.message}.` }
    }

    console.warn("[Sixb] A query of an artifact version did not run:", error)
    return { error: UNREADABLE }
  }
}

/** Every query a version holds, each answered by `read`: as whoever it reads as. */
export async function answerArtifactQueries(
  version: Pick<ArtifactVersionRecord, "files">,
  read: (name: string) => Promise<ArtifactQueryResult | null>
): Promise<ArtifactQueryAnswers> {
  const names = version.files.flatMap((file) => {
    const name = artifactQueryName(file.path)
    return name === undefined ? [] : [name]
  })

  const answers = await Promise.all(
    names.map(async (name) => [name, await answerArtifactQuery(() => read(name))] as const)
  )
  return Object.fromEntries(answers)
}

/** Answers kept as JSON, or `null` when the text holds none. */
export function parseArtifactQueryAnswers(text: string): ArtifactQueryAnswers | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(value)) return null

  const answers: Record<string, ArtifactQueryAnswer> = {}
  for (const [name, answer] of Object.entries(value)) {
    if (!isArtifactQueryName(name) || !isObject(answer)) return null

    if ("result" in answer) answers[name] = { result: answer.result }
    else if (typeof answer.error === "string") answers[name] = { error: answer.error }
    else return null
  }
  return answers
}

const UNREADABLE = "[Sixb] The query could not be read."

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
