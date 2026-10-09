import { appendFileSync } from "node:fs"

// Preloaded into a role under test: records, as the process exits, which terminal UI libraries it
// loaded. Outside a terminal, `atlas` and `app` print plain lines and must load none of them.
const UI_LIBRARY = /\/node_modules\/(ink|react|react-reconciler|yoga-layout)\//

process.on("exit", () => {
  const log = process.env.SIXB_CLI_TEST_LOG
  if (!log) return
  const loaded = new Set<string>()
  for (const path of Object.keys(require.cache)) {
    const name = UI_LIBRARY.exec(path)?.[1]
    if (name) loaded.add(name)
  }
  appendFileSync(log, `${JSON.stringify({ type: "ui:libraries", loaded: [...loaded].sort() })}\n`)
})
