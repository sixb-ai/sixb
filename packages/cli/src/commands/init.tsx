import { cp, mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"
import { InitView, renderStatic } from "../ui"

const TEMPLATE_DIR = resolve(import.meta.dir, "../../../../templates/basic")

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir)
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const entryStat = await stat(fullPath)
    if (entryStat.isDirectory()) {
      const nested = await collectFiles(fullPath)
      files.push(...nested)
      continue
    }
    files.push(fullPath)
  }

  return files
}

async function writeTemplateProject(targetDir: string): Promise<string[]> {
  await cp(TEMPLATE_DIR, targetDir, { recursive: true, force: false })

  const projectName = basename(targetDir)
  const packageJsonPath = join(targetDir, "package.json")
  const packageJson = JSON.parse(await Bun.file(packageJsonPath).text()) as {
    name?: string
  }
  packageJson.name = projectName
  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)

  const configPath = join(targetDir, "pario.config.ts")
  const configSource = await Bun.file(configPath).text()
  const updatedConfig = configSource.replace(/id:\s*"[^"]+"/, `id: "${projectName}"`)
  await writeFile(configPath, updatedConfig)

  const copiedFiles = await collectFiles(targetDir)
  return copiedFiles
    .map((filePath) => relative(targetDir, filePath))
    .filter((filePath) => filePath.length > 0)
    .sort((a, b) => a.localeCompare(b))
}

export async function runInit(dir?: string): Promise<void> {
  const targetDir = resolve(dir ?? ".")
  await mkdir(targetDir, { recursive: true })
  const files = await writeTemplateProject(targetDir)

  await renderStatic(<InitView name={basename(targetDir)} targetDir={targetDir} files={files} />)
}

export async function runCreate(name: string): Promise<void> {
  const targetDir = resolve(name)
  await mkdir(targetDir, { recursive: true })
  const files = await writeTemplateProject(targetDir)

  await renderStatic(<InitView name={name} targetDir={targetDir} files={files} />)
}
