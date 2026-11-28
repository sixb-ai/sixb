import { once } from "node:events"
import type { SQLClient } from "./pg-client"

/** Rows a `COPY` sends at most, as text: one costs a round trip and a statement start. */
export const COPY_BATCH_BYTES = 8 * 1024 * 1024

/**
 * One `COPY … FROM STDIN`, settled by what the server answers.
 *
 * postgres.js 3.4.9 resolves a copy's query as soon as it starts, and when the server refuses a
 * row it never calls the stream's final callback: the error is dropped. A query sent once the
 * copy's data is out runs when the server has answered it, and fails when the copy failed, which
 * aborted the lane's transaction. postgres.js refuses that query until the stream has handed it
 * its last chunk, so it is sent again on the next turn until then.
 */
export async function copyIn(
  sql: SQLClient,
  statement: string,
  chunks: readonly (string | Uint8Array)[]
): Promise<void> {
  const stream = await sql.unsafe(statement).writable()
  for (const chunk of chunks) {
    if (!stream.write(chunk)) await once(stream, "drain")
  }

  const copied = new Promise<"copied">((resolve) => stream.end(() => resolve("copied")))
  for (;;) {
    const answered = sql`SELECT 1`.then(
      () => "answered" as const,
      (error: unknown) => error
    )
    const outcome = await Promise.race([copied, answered])
    if (outcome === "copied" || outcome === "answered") return

    if ((outcome as { code?: unknown } | null)?.code === "COPY_IN_PROGRESS") {
      await new Promise((resolve) => setImmediate(resolve))
      continue
    }

    throw new Error(
      `[SixbPg] PostgreSQL refused a row (${statement.split(" (")[0]}): ${outcome instanceof Error ? outcome.message : String(outcome)}`,
      { cause: outcome }
    )
  }
}

/** A value in COPY's text format: backslash, tab, newline and carriage return escaped. */
export function copyText(value: string): string {
  if (!/[\\\t\n\r]/.test(value)) return value
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
}
