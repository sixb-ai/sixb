// Verifies the `Catching` snippet in `docs/runtime/error-codes.md` compiles. Doc code blocks are
// never type-checked (`buildSnippets.ts` only renders hand-authored hero snippets), which is how a
// version reading `error.details` straight off the guard shipped — `isSixbError` narrows to
// `{ code, message }` and nothing else.
import { isSixbError, toSixbFailure } from "../src"

declare const showFieldErrors: (details: unknown) => void
declare const upsert: () => Promise<void>

export async function catchingSnippet(): Promise<void> {
  try {
    await upsert()
  } catch (error) {
    if (isSixbError(error, "ontology.invalid_value")) {
      return showFieldErrors(toSixbFailure(error).details)
    }
    throw error
  }
}
