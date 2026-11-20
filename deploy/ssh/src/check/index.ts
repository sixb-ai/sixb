/// <reference path="./sh.d.ts" />
import { resolve4, resolve6 } from "node:dns/promises"
import { isIP } from "node:net"
import type { DeployCheck, DeployRelease } from "@sixb/core/deploy"
import { shellQuote } from "../shell"
import type { RemoteShell } from "../transport"
import { type JudgeInput, judge, parseFacts } from "./judge"
import probe from "./probe.sh" with { type: "text" }

export { HOST_REQUIREMENTS } from "./judge"

/** Runs the read-only probe as the deploy account, and judges what it reports. */
export async function checkHost(
  shell: RemoteShell,
  input: JudgeInput & { readonly name: string }
): Promise<DeployCheck[]> {
  const lines: string[] = []
  await shell.run(renderProbe(input), {
    onLine: (line, stream) => {
      if (stream === "stdout") lines.push(line)
    },
  })
  return judge(parseFacts(lines), input)
}

/** The probe, with what it needs to know set above it. */
export function renderProbe(input: {
  readonly name: string
  readonly ports: readonly number[]
  readonly chromium: boolean
}): string {
  return [
    `SIXB_NAME=${shellQuote(input.name)}`,
    `SIXB_PORTS=${shellQuote(input.ports.join(" "))}`,
    `SIXB_CHROMIUM=${input.chromium ? 1 : 0}`,
    probe,
  ].join("\n")
}

/**
 * Where each HTTP domain resolves, against the server's address. Reached over a tailnet or a
 * private network, the server's public address is unknown here, so the check only says where
 * each domain points.
 */
export async function checkDns(release: DeployRelease, hostname: string): Promise<DeployCheck[]> {
  const server = isIP(hostname) ? [hostname] : await lookup(hostname)
  const comparable = server.length > 0 && server.every((address) => !isPrivateAddress(address))
  return Promise.all(
    release.services.flatMap((service) => {
      const domain = service.http?.domain
      if (!domain) return []
      return [
        (async (): Promise<DeployCheck> => {
          const found = await lookup(domain)
          const id = `dns.${service.name}`
          const label = `${service.name} DNS`
          const detail = `${domain} → ${found.join(", ")}`
          if (found.length === 0) {
            return {
              id,
              label,
              status: "warning",
              detail: `${domain} does not resolve`,
              remedy: `Point ${domain} at the server. Until then, Caddy cannot get it a certificate.`,
            }
          }
          if (!comparable || found.some((address) => server.includes(address))) {
            return { id, label, status: "ok", detail }
          }
          const target = server[0] ?? hostname
          return {
            id,
            label,
            status: "warning",
            detail,
            remedy: `Point ${domain} at ${target} with an ${isIP(target) === 6 ? "AAAA" : "A"} record. Until then, Caddy cannot get it a certificate.`,
          }
        })(),
      ]
    })
  )
}

/** Private, carrier-grade NAT (Tailscale's 100.64.0.0/10) and unique-local addresses. */
export function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 6) return /^f[cd]/i.test(address) || address === "::1"
  const [a = 0, b = 0] = address.split(".").map(Number)
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

async function lookup(hostname: string): Promise<string[]> {
  const [v4, v6] = await Promise.all([settle(resolve4(hostname)), settle(resolve6(hostname))])
  return [...v4, ...v6]
}

/** A lookup's answers, or none once it fails or takes over four seconds. */
async function settle(query: Promise<string[]>): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      query.catch(() => []),
      new Promise<string[]>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout([]), 4_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
