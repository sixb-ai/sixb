import type { DeployCheck } from "@sixb/core/deploy"

/** Where every remedy points: the list of what a server provides. */
export const HOST_REQUIREMENTS = "https://docs.sixb.ai/deployment/host-requirements"

/** What the probe reported, by key. */
export type HostFacts = ReadonlyMap<string, string>

export interface JudgeInput {
  /** The loopback ports the deployment's slots listen on. */
  readonly ports: readonly number[]
  /** A deploy writes `.env` from the project's source, so the server needs its token instead. */
  readonly envFromSource: boolean
  /** The project prints with Chromium, so the server needs Chromium's libraries. */
  readonly chromium: boolean
}

const MIN_CADDY = [2, 7] as const
const MIN_FREE_KB = 2 * 1024 * 1024
const ARCHITECTURES = new Set(["x86_64", "amd64", "aarch64", "arm64"])

/** Reads the probe's `fact<TAB>key<TAB>value` lines. */
export function parseFacts(lines: readonly string[]): HostFacts {
  const facts = new Map<string, string>()
  for (const line of lines) {
    const [marker, key, ...value] = line.split("\t")
    if (marker === "fact" && key) facts.set(key, value.join("\t").trim())
  }
  return facts
}

/** What the facts mean for a deploy, one check per host requirement. */
export function judge(facts: HostFacts, input: JudgeInput): DeployCheck[] {
  return [
    server(facts),
    deployments(facts),
    linger(facts),
    caddy(facts),
    adminApi(facts),
    settings(facts, input.envFromSource),
    ports(facts, input.ports),
    ...(input.chromium ? [chromium(facts)] : []),
    disk(facts),
  ]
}

function server(facts: HostFacts): DeployCheck {
  const name = facts.get("os.name") || "an unknown system"
  const family = `${facts.get("os.id") ?? ""} ${facts.get("os.like") ?? ""}`
  const arch = facts.get("os.arch") ?? ""
  const missing = facts.get("os.missing") ?? ""
  const problems = [
    /\b(debian|ubuntu)\b/.test(family) ? "" : `${name} is not Ubuntu or Debian`,
    facts.get("os.systemd") === "yes" ? "" : "systemd is missing",
    ARCHITECTURES.has(arch) ? "" : `Bun has no build for ${arch || "this CPU"}`,
    missing ? `missing ${missing.split(" ").join(", ")}` : "",
  ].filter(Boolean)
  return problems.length === 0
    ? ok("server", "Server", `${name}, ${arch}`)
    : fail("server", "Server", problems.join("; "))
}

function deployments(facts: HostFacts): DeployCheck {
  const others = (facts.get("deployments.others") ?? "").split(" ").filter(Boolean)
  return others.length === 0
    ? ok("deployments", "Deployments", "none other on this server")
    : fail(
        "deployments",
        "Deployments",
        `this server already runs ${others.join(", ")}: a server runs one deployment`
      )
}

function linger(facts: HostFacts): DeployCheck {
  return facts.get("linger") === "yes"
    ? ok("linger", "Services at boot", "lingering is on")
    : fail("linger", "Services at boot", "lingering is off: the services would stop at logout")
}

function caddy(facts: HostFacts): DeployCheck {
  const version = facts.get("caddy.version") ?? ""
  const routes = facts.get("caddy.routes") ?? "the routes folder"
  const problems = [
    !version
      ? "Caddy is not installed"
      : atLeast(version, MIN_CADDY)
        ? ""
        : `Caddy ${version} is older than ${MIN_CADDY.join(".")}`,
    facts.get("caddy.caddyfile-imports") === "yes"
      ? ""
      : "/etc/caddy/Caddyfile does not import /etc/caddy/sixb.d/*.caddy",
    facts.get("caddy.routes-imported") === "yes" ? "" : `nothing imports ${routes}`,
    facts.get("caddy.routes-writable") === "yes" ? "" : `${routes} is missing or not writable`,
    facts.get("caddy.reload") === "yes" ? "" : "sudo systemctl reload caddy is not allowed",
  ].filter(Boolean)
  return problems.length === 0
    ? ok("caddy", "Caddy", `${version}, routes in ${routes}`)
    : fail("caddy", "Caddy", problems.join("; "))
}

function adminApi(facts: HostFacts): DeployCheck {
  return facts.get("caddy.admin-on-localhost") === "yes"
    ? {
        id: "caddy.admin-api",
        label: "Caddy admin API",
        status: "warning",
        detail: "listens on localhost:2019, where any process on the server can change the routes",
        remedy: "Set `admin unix//var/lib/caddy/admin.sock` in the Caddyfile's global options.",
      }
    : ok("caddy.admin-api", "Caddy admin API", "not on localhost:2019")
}

function settings(facts: HostFacts, envFromSource: boolean): DeployCheck {
  if (envFromSource) {
    const token = fileFact(facts.get("file.env-token"))
    if (!token || token.size === 0) {
      return fail("settings", "Settings", "no env token: the deploy can't pull .env")
    }
    return token.mode === "600"
      ? ok("settings", "Settings", "env token in place")
      : fail("settings", "Settings", `the env token is readable by others (mode ${token.mode})`)
  }
  // A deployment from before releases keeps its settings in its code folder.
  const env = fileFact(facts.get("file.shared-env")) ?? fileFact(facts.get("file.legacy-env"))
  if (!env) return fail("settings", "Settings", "no .env on the server")
  return env.mode === "600"
    ? ok("settings", "Settings", ".env in place")
    : fail("settings", "Settings", `.env is readable by others (mode ${env.mode})`)
}

function ports(facts: HostFacts, wanted: readonly number[]): DeployCheck {
  const taken = wanted.filter((port) => facts.get(`port.${port}`) === "other")
  return taken.length === 0
    ? ok("ports", "Ports", wanted.join(", "))
    : fail(
        "ports",
        "Ports",
        `${taken.join(", ")} ${taken.length === 1 ? "is" : "are"} held by another program: a server runs one deployment`
      )
}

function chromium(facts: HostFacts): DeployCheck {
  const missing = facts.get("chromium.missing") ?? ""
  const checked = facts.get("chromium.checked") ?? "system libraries"
  return missing
    ? fail("chromium", "Chromium", `missing ${missing.split(" ").join(", ")} (${checked})`)
    : ok("chromium", "Chromium", "its libraries are installed")
}

function disk(facts: HostFacts): DeployCheck {
  const freeKb = Number(facts.get("disk.free-kb") ?? 0)
  return freeKb >= MIN_FREE_KB
    ? ok("disk", "Disk space", `${Math.floor(freeKb / 1048576)} GB free`)
    : {
        id: "disk",
        label: "Disk space",
        status: "warning",
        detail: `${Math.floor(freeKb / 1024)} MB free`,
        remedy: "A release needs about 1 GB while it builds.",
      }
}

function ok(id: string, label: string, detail: string): DeployCheck {
  return { id, label, status: "ok", detail }
}

function fail(id: string, label: string, detail: string): DeployCheck {
  return { id, label, status: "fail", detail, remedy: `See ${HOST_REQUIREMENTS}.` }
}

/** `mode size` from the probe, or nothing when the file is missing. */
function fileFact(value: string | undefined): { mode: string; size: number } | null {
  if (!value || value === "missing") return null
  const [mode = "", size = "0"] = value.split(" ")
  return { mode, size: Number(size) }
}

function atLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10) || 0)
  for (const [index, wanted] of minimum.entries()) {
    const part = parts[index] ?? 0
    if (part !== wanted) return part > wanted
  }
  return true
}
