import { mkdir, readFile, symlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { dirname, join, resolve } from "node:path"
import { buildApp } from "../../src/build"
import { createCustomApp } from "../../src/createCustomApp"

const scenario = process.argv[2]
const root = process.argv[3]
if (!scenario || !root) {
  throw new Error("Expected a shared app e2e scenario and an isolated root directory.")
}

if (scenario === "dev-shells") {
  await runDevShells(root)
} else if (scenario === "production-shells") {
  await runProductionShells(root)
} else if (scenario === "html-entries") {
  await runHtmlEntries(root)
} else {
  throw new Error(`Unknown shared app e2e scenario '${scenario}'.`)
}

async function runDevShells(projectRoot: string): Promise<void> {
  await prepareSharedProject(projectRoot)
  const port = await getFreePort()
  const app = await createCustomApp({
    rootDir: projectRoot,
    apiBaseUrl: "https://api.example.com",
    authEnabled: true,
    agentRoutes: false,
  })
  const server = await app.dev({ host: "127.0.0.1", port })

  try {
    const application = await fetch(`http://127.0.0.1:${port}/`)
    const shared = await fetch(`http://127.0.0.1:${port}/shared/published-report/shr_1`)
    const internalSharedShell = await fetch(
      `http://127.0.0.1:${port}/__sixb/generated/shared-app-shell`
    )
    assertEqual(application.status, 200, "application shell status")
    assertEqual(shared.status, 200, "shared shell status")
    assertEqual(internalSharedShell.status, 404, "private shared shell status")

    const applicationHtml = await application.text()
    const sharedHtml = await shared.text()
    const sharedCsp = shared.headers.get("content-security-policy") ?? ""
    const scriptNonce = sharedHtml.match(/<script nonce="([^"]+)"/)?.[1]
    assert(applicationHtml !== sharedHtml, "application and shared shells must differ")
    assert(scriptNonce, "shared shell must contain a script nonce")
    assertIncludes(sharedCsp, `'nonce-${scriptNonce}'`, "shared CSP nonce")
    assertEqual(shared.headers.get("cache-control"), "no-store", "shared cache policy")
    assertEqual(shared.headers.get("referrer-policy"), "no-referrer", "shared referrer policy")
    assertEqual(
      shared.headers.get("x-robots-tag"),
      "noindex, nofollow, noarchive",
      "shared robots policy"
    )
    assertIncludes(
      sharedCsp,
      "connect-src 'self' https://api.example.com",
      "shared API connection policy"
    )

    const mutation = await fetch(`http://127.0.0.1:${port}/shared/published-report/shr_1`, {
      method: "POST",
    })
    assertEqual(mutation.status, 404, "shared shell mutation status")

    const applicationRoutes = await readFile(
      join(projectRoot, ".sixb", "generated", "routes.ts"),
      "utf-8"
    )
    const sharedRoutes = await readFile(
      join(projectRoot, ".sixb", "generated", "shared-routes.ts"),
      "utf-8"
    )
    assert(
      !applicationRoutes.includes("published-report"),
      "normal routes must exclude shared page"
    )
    assert(sharedRoutes.includes("published-report"), "shared routes must include shared page")
  } finally {
    await server.stop()
  }
}

async function runProductionShells(projectRoot: string): Promise<void> {
  await prepareSharedProject(projectRoot)
  const outdir = join(projectRoot, ".sixb", "dist", "app")
  await mkdir(join(projectRoot, "app", "public"), { recursive: true })
  await writeFile(
    join(projectRoot, "app", "public", "shared-index.html"),
    "<!doctype html><p>Public file must not replace the shared shell.</p>\n"
  )

  const app = await createCustomApp({
    rootDir: projectRoot,
    authEnabled: true,
    agentRoutes: false,
  })
  const result = await app.build({ outdir })
  assert(result.success, `shared app build failed: ${result.logs?.join("\n") ?? "unknown error"}`)
  assert(
    !(await readFile(join(outdir, "shared-index.html"), "utf-8")).includes(
      "Public file must not replace"
    ),
    "public assets must not replace the framework shared shell"
  )

  const port = await getFreePort()
  const server = await app.start({
    host: "127.0.0.1",
    port,
    outdir,
    apiBaseUrl: "https://api.example.com",
    authEnabled: true,
  })
  try {
    const application = await fetch(`http://127.0.0.1:${port}/`)
    const shared = await fetch(`http://127.0.0.1:${port}/shared/published-report/shr_1`)
    const rawSharedShell = await fetch(`http://127.0.0.1:${port}/shared-index.html`)
    assertEqual(application.status, 200, "production application shell status")
    assertEqual(shared.status, 200, "production shared shell status")
    assertEqual(rawSharedShell.status, 404, "raw shared shell status")
    assert((await application.text()) !== (await shared.text()), "production shells must differ")
    assertIncludes(
      shared.headers.get("content-security-policy") ?? "",
      "connect-src 'self' https://api.example.com",
      "production shared CSP"
    )
  } finally {
    await server.stop()
  }
}

async function runHtmlEntries(projectRoot: string): Promise<void> {
  const generatedDir = join(projectRoot, "generated")
  const outdir = join(projectRoot, "dist")
  await mkdir(generatedDir, { recursive: true })
  await writeFile(join(generatedDir, "main.ts"), 'document.body.dataset.entry = "app"\n')
  await writeFile(join(generatedDir, "shared-main.ts"), 'document.body.dataset.entry = "shared"\n')
  await writeFile(
    join(generatedDir, "index.html"),
    '<!doctype html><body><script type="module" src="./main.ts"></script></body>\n'
  )
  await writeFile(
    join(generatedDir, "shared-index.html"),
    '<!doctype html><body><script type="module" src="./shared-main.ts"></script></body>\n'
  )

  const result = await buildApp({
    entryPath: join(generatedDir, "index.html"),
    sharedEntryPath: join(generatedDir, "shared-index.html"),
    outdir,
  })
  assert(result.success, `HTML entry build failed: ${result.logs?.join("\n") ?? "unknown error"}`)

  const applicationHtml = await readFile(join(outdir, "index.html"), "utf-8")
  const sharedHtml = await readFile(join(outdir, "shared-index.html"), "utf-8")
  assert(/src=["']\/[^"']+\.js["']/.test(applicationHtml), "normal assets must be root-relative")
  assert(/src=["']\/[^"']+\.js["']/.test(sharedHtml), "shared assets must be root-relative")
  assert(applicationHtml !== sharedHtml, "built HTML entries must differ")
  assert(
    !(await Bun.file(join(generatedDir, "index.sixb-bundle.html")).exists()),
    "normal temporary bundle entry must be removed"
  )
  assert(
    !(await Bun.file(join(generatedDir, "shared-index.sixb-bundle.html")).exists()),
    "shared temporary bundle entry must be removed"
  )
}

async function prepareSharedProject(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, "app", "shared", "published-report", "[grantId]"), {
    recursive: true,
  })
  await writeFile(
    join(projectRoot, "app", "page.tsx"),
    "export default function AppPage() { return <main>Application shell</main> }\n"
  )
  await writeFile(
    join(projectRoot, "app", "shared", "published-report", "[grantId]", "page.tsx"),
    "export default function SharedPage() { return <main>Shared shell</main> }\n"
  )
  await linkSharedAppDependencies(projectRoot)
}

async function linkSharedAppDependencies(projectRoot: string): Promise<void> {
  const appPackageRoot = resolve(import.meta.dir, "../..")
  const targets = new Map<string, string>([
    ["@sixb/app", appPackageRoot],
    ["@sixb/client", resolve(appPackageRoot, "../client")],
    ["@tanstack/react-query", join(appPackageRoot, "node_modules", "@tanstack/react-query")],
    ["react", join(appPackageRoot, "node_modules", "react")],
    ["react-dom", join(appPackageRoot, "node_modules", "react-dom")],
    ["react-router-dom", join(appPackageRoot, "node_modules", "react-router-dom")],
  ])

  for (const [name, source] of targets) {
    const target = join(projectRoot, "node_modules", ...name.split("/"))
    await mkdir(dirname(target), { recursive: true })
    await symlink(source, target, "dir")
  }
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolvePort, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new Error("Could not resolve an open port"))
        return
      }
      server.close((error) => (error ? reject(error) : resolvePort(address.port)))
    })
  })
}

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`)
  }
}

function assertIncludes(actual: string, expected: string, label: string): void {
  if (!actual.includes(expected)) {
    throw new Error(
      `${label}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`
    )
  }
}
