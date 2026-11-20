import type { DeployCheck } from "@sixb/core/deploy"

/** Where every remedy points: the list of what a server provides. */
export const HOST_REQUIREMENTS = "https://docs.sixb.ai/deployment/host-requirements"
const ENV_TOKEN_DOCS = "https://docs.sixb.ai/deployment/environment-variables#deploy"

/** What the probe reported, by key. */
export type HostFacts = ReadonlyMap<string, string>

export interface JudgeInput {
  /** The deployment's `name`: its folder in the account's home. */
  readonly name: string
  /** The loopback ports the deployment's slots listen on. */
  readonly ports: readonly number[]
  /**
   * Where the server's settings come from: the project's source, read with the env token or with
   * the server's own identity, or the `.env` kept on the server.
   */
  readonly settings: "env-token" | "identity" | "env-file"
  /** The project prints with Chromium, so the server needs Chromium's libraries. */
  readonly chromium: boolean
}

/** The Debian package each tool the deploy uses comes in. */
const TOOL_PACKAGES: Readonly<Record<string, string>> = {
  curl: "curl",
  unzip: "unzip",
  tar: "tar",
  flock: "util-linux",
  setsid: "util-linux",
  sha256sum: "coreutils",
  stat: "coreutils",
  ss: "iproute2",
}

/** Caddy from its own apt repository, as its documentation installs it. */
const INSTALL_CADDY = [
  "curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg",
  "curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list",
  "apt-get update && apt-get install -y caddy",
]

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
  // The fixes name the account and its home as the server reports them, and are pasted into a root
  // shell: anything that would need quoting gets no commands, only the remedy.
  const user = pasteable(facts.get("account.name"))
  const home = pasteable(facts.get("account.home"))
  const root = home && pasteable(input.name) ? `${home}/${input.name}` : null
  return [
    server(facts),
    account(facts),
    deployments(facts),
    linger(facts, user),
    caddy(facts, user),
    settings(facts, input.settings, root),
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
  const packages = [...new Set(missing.split(" ").flatMap((tool) => TOOL_PACKAGES[tool] ?? []))]
  return problems.length === 0
    ? ok("server", "Server", `${name}, ${arch}`)
    : fail("server", "Server", problems.join("; "), {
        commands: packages.length > 0 ? [`apt-get install -y ${packages.join(" ")}`] : [],
      })
}

/** `root` is refused in `sixb.deploy.ts`, and again here, where SSH config could still map to it. */
function account(facts: HostFacts): DeployCheck {
  const name = facts.get("account.name") || "an unknown account"
  return facts.get("account.uid") === "0"
    ? fail("account", "Account", `${name} is root: deploy as an account without root access`)
    : ok("account", "Account", name)
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

function linger(facts: HostFacts, user: string | null): DeployCheck {
  return facts.get("linger") === "yes"
    ? ok("linger", "Services at boot", "lingering is on")
    : fail("linger", "Services at boot", "lingering is off: the services would stop at logout", {
        commands: user ? [`loginctl enable-linger ${user}`] : [],
      })
}

function caddy(facts: HostFacts, user: string | null): DeployCheck {
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
  if (problems.length === 0) return ok("caddy", "Caddy", `${version}, routes in ${routes}`)

  const folder = `/etc/caddy/sixb.d/${user}`
  const configure = !user
    ? []
    : [
        ...(facts.get("caddy.caddyfile-imports") === "yes"
          ? []
          : [
              // Safe to paste twice: a second import of the same files is an error Caddy won't reload.
              "grep -qxF 'import /etc/caddy/sixb.d/*.caddy' /etc/caddy/Caddyfile || echo 'import /etc/caddy/sixb.d/*.caddy' >> /etc/caddy/Caddyfile",
            ]),
        ...(facts.get("caddy.routes-imported") === "yes"
          ? []
          : [
              "install -d -m 0755 /etc/caddy/sixb.d",
              `echo 'import ${folder}/*.caddy' > ${folder}.caddy`,
            ]),
        ...(facts.get("caddy.routes-writable") === "yes"
          ? []
          : [`install -d -m 0755 -o ${user} -g ${user} ${folder}`]),
        ...(facts.get("caddy.reload") === "yes"
          ? []
          : [
              `echo '${user} ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy' > /etc/sudoers.d/${user}`,
              `chmod 440 /etc/sudoers.d/${user}`,
            ]),
      ]
  const install = !version
    ? INSTALL_CADDY
    : atLeast(version, MIN_CADDY)
      ? []
      : ["apt-get update && apt-get install -y --only-upgrade caddy"]
  return fail("caddy", "Caddy", problems.join("; "), {
    commands: [
      ...install,
      ...configure,
      ...(configure.length > 0 ? ["systemctl reload caddy"] : []),
    ],
  })
}

function settings(
  facts: HostFacts,
  source: JudgeInput["settings"],
  root: string | null
): DeployCheck {
  const folder = root ?? "~/<name>"
  if (source === "identity") {
    return ok("settings", "Settings", "the source reads with the server's own identity")
  }
  if (source === "env-token") {
    const token = fileFact(facts.get("file.env-token"))
    if (!token || token.size === 0) {
      return fail("settings", "Settings", "no env token: the deploy can't pull .env", {
        remedy: `Put a read-only token for the project's prod values at ${folder}/env-token, mode 600. See ${ENV_TOKEN_DOCS}.`,
      })
    }
    return privateMode(token.mode)
      ? ok("settings", "Settings", "env token in place")
      : fail("settings", "Settings", `the env token is readable by others (mode ${token.mode})`, {
          commands: root ? [`chmod 600 ${root}/env-token`] : [],
        })
  }
  // A deployment from before releases keeps its settings in its code folder.
  const shared = fileFact(facts.get("file.shared-env"))
  const env = shared ?? fileFact(facts.get("file.legacy-env"))
  if (!env) {
    return fail("settings", "Settings", "no .env on the server", {
      remedy: `Create ${folder}/shared/.env, mode 600, with the project's settings.`,
    })
  }
  return privateMode(env.mode)
    ? ok("settings", "Settings", ".env in place")
    : fail("settings", "Settings", `.env is readable by others (mode ${env.mode})`, {
        commands: shared && root ? [`chmod 600 ${root}/shared/.env`] : [],
      })
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
    ? fail("chromium", "Chromium", `missing ${missing.split(" ").join(", ")} (${checked})`, {
        remedy: "Install them as root, such as with `npx playwright install-deps chromium`.",
      })
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

/** A failed requirement, with what fixes it: commands to run as root, when there are some. */
function fail(
  id: string,
  label: string,
  detail: string,
  fix: { readonly remedy?: string; readonly commands?: readonly string[] } = {}
): DeployCheck {
  const commands = fix.commands ?? []
  return {
    id,
    label,
    status: "fail",
    detail,
    remedy: fix.remedy ?? `See ${HOST_REQUIREMENTS}.`,
    ...(commands.length > 0 ? { commands } : {}),
  }
}

/** A name or path that pastes into a shell as it is, or nothing when it would need quoting. */
function pasteable(value: string | undefined): string | null {
  return value && /^[A-Za-z0-9._/-]+$/.test(value) ? value : null
}

/** Readable by its owner alone: no group or other bits, as 600 or 400. */
function privateMode(mode: string): boolean {
  const bits = Number.parseInt(mode, 8)
  return Number.isInteger(bits) && (bits & 0o077) === 0
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
