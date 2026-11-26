import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  BRANCH_BUN_COMMAND,
  BRANCH_BUN_VERSION,
  BRANCH_INSTALL_COMMAND,
  BRANCH_RUNTIME_COMMAND,
  branchCheckout,
} from "../src/branches"

// The commands a hosted branch's sandbox runs, run here by a real shell, with stand-ins for npm,
// Bun and `sixb` that write down how they were called.

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "sixb-branch-checkout-"))
  directories.push(root)
  const home = join(root, "home")
  const bin = join(root, "bin")
  const work = join(root, "work")
  for (const directory of [home, bin, work]) await mkdir(directory, { recursive: true })

  const calls = join(root, "calls")
  const tool = async (path: string, body: string) => {
    await mkdir(join(path, ".."), { recursive: true })
    await writeFile(path, `#!/bin/sh\n${body}\n`)
    await chmod(path, 0o755)
  }

  // npm installs the `bun` package where it is told, its binary under `.bin`, as the real one.
  const npm = () =>
    tool(
      join(bin, "npm"),
      [
        `echo "npm $*" >> "${calls}"`,
        'while [ "$1" != "--prefix" ]; do shift; done',
        'mkdir -p "$2/node_modules/.bin"',
        `printf '#!/bin/sh\\necho "bun $*" >> "${calls}"\\n' > "$2/node_modules/.bin/bun"`,
        'chmod +x "$2/node_modules/.bin/bun"',
      ].join("\n")
    )
  const imageBun = () => tool(join(bin, "bun"), `echo "image bun $*" >> "${calls}"`)

  const run = async (script: string, cwd = work) => {
    const child = Bun.spawn(["sh", "-c", script], {
      cwd,
      // No Bun of this machine's: only what the test puts on the PATH.
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000)
    try {
      const [stderr, exitCode] = await Promise.all([
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { exitCode, stderr }
    } finally {
      clearTimeout(timer)
    }
  }
  const called = async () =>
    (await readFile(calls, "utf8").catch(() => "")).split("\n").filter(Boolean)

  return { home, work, npm, imageBun, run, called, tool }
}

describe("a branch's checkout", () => {
  // Vercel's stock runtime has Node and no Bun, which the branch's install and `sixb dev` need.
  // Guard check: drop the npm install from `BRANCH_BUN_COMMAND` (`core/src/branches/source.ts`).
  test("installs the pinned Bun from the npm registry when the image has none", async () => {
    const box = await sandbox()
    await box.npm()

    const installed = await box.run(BRANCH_BUN_COMMAND)

    expect(installed).toEqual({ exitCode: 0, stderr: "" })
    expect(await box.called()).toEqual([
      `npm install --prefix ${box.home}/.sixb-branch --no-audit --no-fund --loglevel=error bun@${BRANCH_BUN_VERSION}`,
      "bun --version",
    ])
  })

  test("keeps the image's own Bun", async () => {
    const box = await sandbox()
    await box.npm()
    await box.imageBun()

    expect((await box.run(BRANCH_BUN_COMMAND)).exitCode).toBe(0)
    expect(await box.called()).toEqual([])
  })

  test("says what to do when the image has neither Bun nor npm", async () => {
    const box = await sandbox()

    const installed = await box.run(BRANCH_BUN_COMMAND)

    expect(installed.exitCode).toBe(1)
    expect(installed.stderr).toContain("boot it from an image with Bun")
  })

  // Guard check: drop `BRANCH_TOOLS_PATH` from `BRANCH_INSTALL_COMMAND` or `BRANCH_RUNTIME_COMMAND`.
  test("installs and runs the branch with the Bun it installed", async () => {
    const box = await sandbox()
    await box.npm()
    await box.run(BRANCH_BUN_COMMAND)
    await writeFile(join(box.work, "bun.lock"), "")
    await box.run("git init --quiet .")
    // The project's own `sixb`, a Bun script, as `@sixb/cli` installs it.
    await box.tool(join(box.work, "node_modules", ".bin", "sixb"), 'exec bun sixb-cli "$@"')

    expect((await box.run(BRANCH_INSTALL_COMMAND)).exitCode).toBe(0)
    expect((await box.run(`SIXB_BRANCH_PORT=4100; ${BRANCH_RUNTIME_COMMAND}`)).exitCode).toBe(0)
    expect((await box.called()).slice(2)).toEqual([
      "bun install --frozen-lockfile",
      "bun sixb-cli dev --port 4100 --host 0.0.0.0",
    ])
  })

  test("pins the Bun this repository builds with", async () => {
    const pinned = (await readFile(join(import.meta.dir, "../../../.bun-version"), "utf8")).trim()
    expect(BRANCH_BUN_VERSION).toBe(pinned)
  })

  test("clones the branch, then installs, then marks the checkout done", () => {
    const steps = branchCheckout({
      source: { repository: "acme/shop" },
      branch: "feature/invoices",
    })

    expect(steps.map((step) => step.name)).toEqual([
      "install Bun",
      "clone the branch",
      "install the branch's dependencies",
      "finish the checkout",
    ])
    expect(steps[1]?.script).toBe(
      "git clone --quiet -- 'https://github.com/acme/shop.git' . && git checkout --quiet 'feature/invoices'"
    )
  })
})
