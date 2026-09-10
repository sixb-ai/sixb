import { type Dirent, watch } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

const ignoredDirectories = new Set([
  ".sixb",
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".local",
])
const isAppSource = (path: string) => path.startsWith(`app${sep}`)
const isSource = (path: string) =>
  /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|css)$/.test(path) || path === "bun.lock"
const ignored = (path: string) => path.split(sep).some((part) => ignoredDirectories.has(part))

function missing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  )
}

async function statPath(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

/** Targeted native checks, with a bounded-concurrency async scan for missed events. */
export function watchDevSource(
  root: string,
  hasCustomApp: () => boolean,
  onChange: (path: string) => void,
  onError: (error: unknown) => void
) {
  const previous = new Map<string, string>()
  const dirty = new Set<string>()
  let closed = false
  let fullCheck = false
  let nativeQueued = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  let fallback: ReturnType<typeof setTimeout> | undefined
  let chain: Promise<void> = Promise.resolve()

  async function snapshot(directory: string, skipApp: boolean): Promise<Map<string, string>> {
    const files = new Map<string, string>()
    async function scan(path: string) {
      if (closed || ignored(path) || (skipApp && isAppSource(path))) return
      // Dirents avoid stat'ing non-source files or following directory symlinks.
      let children: Dirent[]
      try {
        children = await readdir(resolve(root, path), { withFileTypes: true })
      } catch (error) {
        if (missing(error)) return
        throw error
      }
      if (path === "app") {
        const stat = await statPath(resolve(root, path))
        if (stat && !stat.isSymbolicLink()) files.set(path, String(stat.ino))
        if (skipApp) return
      }
      for (let offset = 0; offset < children.length && !closed; offset += 32) {
        const batch = children.slice(offset, offset + 32)
        await Promise.all(
          batch
            .filter((entry) => entry.isFile() && isSource(join(path, entry.name)))
            .map(async (entry) => {
              const file = join(path, entry.name)
              if (ignored(file)) return
              const stat = await statPath(resolve(root, file))
              if (stat?.isFile()) files.set(file, fingerprint(stat))
            })
        )
        // Recurse serially: nested directories cannot multiply the IO concurrency.
        for (const entry of batch) if (entry.isDirectory()) await scan(join(path, entry.name))
      }
    }
    await scan(directory)
    return files
  }

  function fingerprint(stat: NonNullable<Awaited<ReturnType<typeof statPath>>>): string {
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
  }

  function apply(next: Map<string, string>, directory: string, skipApp: boolean, notify: boolean) {
    if (closed) return
    let changed: string | undefined
    const markChanged = (path: string) => {
      if (!(hasCustomApp() && isAppSource(path))) changed ??= path
    }
    const inScope = (path: string) =>
      (!directory || path === directory || path.startsWith(`${directory}${sep}`)) &&
      !(skipApp && isAppSource(path))
    for (const [path, value] of next) {
      if (previous.get(path) !== value) markChanged(path)
      previous.set(path, value)
    }
    for (const path of previous.keys()) {
      if (inScope(path) && !next.has(path)) {
        markChanged(path)
        previous.delete(path)
      }
    }
    if (notify && changed) onChange(changed)
  }

  async function reconcile(notify = true) {
    const skipApp = hasCustomApp()
    apply(await snapshot("", skipApp), "", skipApp, notify)
  }

  async function checkPath(path: string) {
    if (closed || ignored(path) || (hasCustomApp() && isAppSource(path))) return
    const stat = await statPath(resolve(root, path))
    if (stat?.isDirectory()) {
      const skipApp = hasCustomApp()
      apply(await snapshot(path, skipApp), path, skipApp, true)
    } else if (stat?.isFile() && isSource(path)) {
      const value = fingerprint(stat)
      if (!closed && previous.get(path) !== value) {
        previous.set(path, value)
        if (!(hasCustomApp() && isAppSource(path))) onChange(path)
      }
    } else if (!stat || stat.isSymbolicLink()) {
      apply(new Map(), path, hasCustomApp(), true)
    }
  }

  function enqueue(work: () => Promise<void>): Promise<void> {
    const result = chain.then(async () => {
      if (!closed) await work()
    })
    chain = result.catch((error) => {
      if (!closed) onError(error)
    })
    return result
  }

  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (closed) return
    if (filename) {
      const path = String(filename)
      if (ignored(path) || (hasCustomApp() && isAppSource(path))) return
      dirty.add(path)
    } else fullCheck = true
    clearTimeout(debounce)
    debounce = setTimeout(() => {
      if (nativeQueued || closed) return
      nativeQueued = true
      void enqueue(async () => {
        nativeQueued = false
        const paths = [...dirty]
        dirty.clear()
        const full = fullCheck
        fullCheck = false
        if (full) await reconcile()
        else for (const path of paths) await checkPath(path)
      }).catch(() => {}) // enqueue reports failures and keeps the queue usable.
    }, 100)
  })
  watcher.on("error", onError)

  function scheduleFallback() {
    if (closed) return
    fallback = setTimeout(() => {
      // Bun 1.3.14/macOS can omit recursive events. Keep recovery, but never queue
      // overlapping scans or block the event loop with synchronous filesystem IO.
      void enqueue(() => reconcile())
        .catch(() => {})
        .finally(scheduleFallback)
    }, 5000)
  }
  const ready = enqueue(() => reconcile(false))
  scheduleFallback()
  return {
    ready,
    // Rebase before spawning: saves during shutdown are included in the next child,
    // and app fingerprints are refreshed before handing its edits back to HMR.
    refresh: () => enqueue(() => reconcile(false)),
    async close() {
      closed = true
      clearTimeout(debounce)
      clearTimeout(fallback)
      watcher.close()
      dirty.clear()
      await chain
      previous.clear()
    },
  }
}
