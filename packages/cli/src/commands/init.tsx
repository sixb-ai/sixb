import { relative, sep } from "node:path"
import { scaffoldProject } from "create-sixb/scaffold"
import { InitView, renderStatic } from "../ui"

export async function runInit(dir?: string): Promise<void> {
  const result = await scaffoldProject(dir ?? ".", { allowExisting: true })

  await renderStatic(
    <InitView
      name={result.name}
      targetDir={result.targetDir}
      files={result.files}
      commands={nextStepsFor(result.targetDir)}
    />
  )
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
