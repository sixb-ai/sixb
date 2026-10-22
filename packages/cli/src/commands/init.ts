import { relative, sep } from "node:path"
import { scaffoldProject } from "create-sixb/scaffold"
import { initView, renderStatic } from "../ui"
import { canRunLive } from "../ui/live/can-run-live"

export async function runInit(dir?: string): Promise<void> {
  const target = dir ?? (canRunLive() ? await askForDirectory() : ".")
  const result = await scaffoldProject(target, { allowExisting: true })

  await renderStatic(
    initView({
      name: result.name,
      targetDir: result.targetDir,
      files: result.files,
      commands: nextStepsFor(result.targetDir),
    })
  )
}

async function askForDirectory(): Promise<string> {
  const { promptText } = await import("../ui/live/prompt")
  return promptText({
    command: "init",
    label: "Project directory",
    defaultValue: ".",
    hint: "A new folder for the project, or . for this one",
  })
}

function nextStepsFor(targetDir: string): string[] {
  const target = relative(process.cwd(), targetDir)
  const commands: string[] = []

  if (target) {
    const outsideCwd = target === ".." || target.startsWith(`..${sep}`)
    commands.push(`cd ${quoteShellArgument(outsideCwd ? targetDir : target)}`)
  }

  commands.push("bun install", "bun run dev")
  return commands
}

function quoteShellArgument(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
