// The engine of the Agent's `glob` and `grep`, as a run installs it at `lib/search.mjs` and runs
// it on Bun or Node: `bun run generate:search-script` bundles it into src/generated/search.mjs.
import { runSearchCommand } from "./command"

const result = await runSearchCommand(process.argv.slice(2), process.cwd())

process.stdout.write(result.stdout)
process.stderr.write(result.stderr)
process.exitCode = result.exitCode
