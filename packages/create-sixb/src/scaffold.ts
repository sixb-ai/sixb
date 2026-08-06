import { access, cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { basename, join, relative, resolve } from "node:path"

export interface ScaffoldProjectOptions {
  /** Preserve `sixb init` semantics for explicitly initialized existing directories. */
  allowExisting?: boolean
}

export interface ScaffoldProjectResult {
  name: string
  targetDir: string
  files: string[]
}

let templateDirPromise: Promise<string> | null = null
let packageVersionPromise: Promise<string> | null = null

export async function scaffoldProject(
  directory: string,
  options: ScaffoldProjectOptions = {}
): Promise<ScaffoldProjectResult> {
  const targetDir = resolve(directory)
  await prepareTargetDirectory(targetDir, options.allowExisting ?? false)
  await cp(await resolveTemplateDir(), targetDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
  })
  await installGitignore(targetDir)
  await installProjectTsconfig(targetDir)

  const name = basename(targetDir)
  await rewritePackageJson(targetDir, name, await resolvePackageVersion())
  await rewriteProjectId(targetDir, name)

  return {
    name,
    targetDir,
    files: await collectRelativeFiles(targetDir),
  }
}

async function prepareTargetDirectory(targetDir: string, allowExisting: boolean): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(targetDir)
  } catch (error) {
    if (isMissingPathError(error)) {
      await mkdir(targetDir, { recursive: true })
      return
    }
    throw error
  }

  if (!allowExisting && entries.length > 0) {
    throw new Error(`Target directory is not empty: ${targetDir}`)
  }
}

async function resolveTemplateDir(): Promise<string> {
  templateDirPromise ??= findTemplateDir()
  return await templateDirPromise
}

async function findTemplateDir(): Promise<string> {
  const candidates = [join(import.meta.dir, "template"), resolve(import.meta.dir, "../template")]

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {}
  }

  throw new Error("Could not find the create-sixb template files.")
}

async function resolvePackageVersion(): Promise<string> {
  packageVersionPromise ??= readPackageVersion()
  return await packageVersionPromise
}

async function readPackageVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(resolve(import.meta.dir, "../package.json"), "utf8")
  ) as { version?: unknown }

  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Could not determine the create-sixb package version.")
  }
  return packageJson.version
}

async function installGitignore(targetDir: string): Promise<void> {
  const source = join(targetDir, "gitignore")
  const target = join(targetDir, ".gitignore")

  try {
    const [existing, template] = await Promise.all([
      readFile(target, "utf8"),
      readFile(source, "utf8"),
    ])
    const existingLines = new Set(existing.split(/\r?\n/))
    const additions = template.split(/\r?\n/).filter((line) => line && !existingLines.has(line))
    const separator = existing.length > 0 && !existing.endsWith("\n") ? "\n" : ""
    const suffix = additions.length > 0 ? `${separator}${additions.join("\n")}\n` : ""
    await writeFile(target, `${existing}${suffix}`)
    await rm(source)
  } catch (error) {
    if (!isMissingPathError(error)) throw error
    await rename(source, target)
  }
}

async function installProjectTsconfig(targetDir: string): Promise<void> {
  const source = join(targetDir, "tsconfig.scaffold.json")
  const target = join(targetDir, "tsconfig.json")

  await cp(source, target, { force: false, errorOnExist: true })
  await rm(source)
}

async function rewritePackageJson(
  targetDir: string,
  projectName: string,
  packageVersion: string
): Promise<void> {
  const packageJsonPath = join(targetDir, "package.json")
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    name?: string
    dependencies?: Record<string, string>
  }

  packageJson.name = projectName
  for (const dependency of Object.keys(packageJson.dependencies ?? {})) {
    if (dependency.startsWith("@sixb/")) {
      packageJson.dependencies![dependency] = `^${packageVersion}`
    }
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
}

async function rewriteProjectId(targetDir: string, projectName: string): Promise<void> {
  const configPath = join(targetDir, "sixb.config.ts")
  const configSource = await readFile(configPath, "utf8")
  const updatedConfig = configSource.replace(
    /const projectId = "[^"]+"/,
    `const projectId = ${JSON.stringify(projectName)}`
  )

  if (updatedConfig === configSource) {
    throw new Error("Could not set the project id in sixb.config.ts.")
  }
  await writeFile(configPath, updatedConfig)
}

async function collectRelativeFiles(targetDir: string): Promise<string[]> {
  const files = await collectFiles(targetDir)
  return files
    .map((filePath) => relative(targetDir, filePath))
    .filter((filePath) => filePath.length > 0)
    .sort((a, b) => a.localeCompare(b))
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(path)))
    } else {
      files.push(path)
    }
  }
  return files
}

function isMissingPathError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT"
}
