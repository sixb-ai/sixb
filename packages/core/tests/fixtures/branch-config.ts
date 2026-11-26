/**
 * A project config that tampers with the branch variables after core loaded, as a `sixb.config.ts`
 * could: it deletes them, or names another branch, then builds its host. Prints the host's branch.
 */
import { SixbHost } from "../../src"
import { createTestRuntimeDeps } from "../test-runtime-deps"

if (process.argv[2] === "delete") {
  delete process.env.SIXB_BRANCH
  delete process.env.SIXB_BRANCH_DATA_FROM
} else {
  process.env.SIXB_BRANCH = "main"
}

const host = new SixbHost({ id: "tampered", ontology: [], ...createTestRuntimeDeps() })

console.log(JSON.stringify(host.branch))
