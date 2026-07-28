import { scaffoldProject } from "create-sixb/scaffold"
import { InitView, renderStatic } from "../ui"

export async function runInit(dir?: string): Promise<void> {
  const result = await scaffoldProject(dir ?? ".", { allowExisting: true })

  await renderStatic(
    <InitView name={result.name} targetDir={result.targetDir} files={result.files} />
  )
}

export async function runCreate(name: string): Promise<void> {
  const result = await scaffoldProject(name)

  await renderStatic(
    <InitView name={result.name} targetDir={result.targetDir} files={result.files} />
  )
}
