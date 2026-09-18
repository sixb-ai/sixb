import { beforeAll, expect, test } from "bun:test"
import { AzureSandboxFactory } from "../src"
import { buildGuestArtifact } from "./guest-build"

const enabled = process.env.SIXB_AZURE_E2E === "1"
beforeAll(async () => {
  if (enabled) await buildGuestArtifact()
}, 20_000)
const factory = () =>
  new AzureSandboxFactory({
    subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
    resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
    sandboxGroup: process.env.AZURE_SANDBOX_GROUP!,
    region: process.env.AZURE_SANDBOX_REGION ?? "westus3",
    image: process.env.AZURE_SANDBOX_IMAGE_ID
      ? { type: "disk", id: process.env.AZURE_SANDBOX_IMAGE_ID }
      : { type: "public", name: "node-22" },
    resources: { vcpus: 1, memoryMiB: 2048, diskGiB: 20 },
    timeout: 10_000,
    pollIntervalMs: 200,
  })

test.skipIf(!enabled)(
  "Azure inspected HTTPS restricts hosts, schemes, ports and host spoofing",
  async () => {
    // Establish reachable controls so a down endpoint cannot masquerade as policy enforcement.
    const unrestricted = await factory().create({ network: { mode: "all" } })
    try {
      for (const url of [
        "https://example.com",
        "https://example.org",
        "http://example.com",
        "http://portquiz.net:8080",
      ]) {
        const result = await unrestricted.runCommand("curl", [
          "--noproxy",
          "*",
          "-fsS",
          "--max-time",
          "5",
          url,
        ])
        expect(result.exitCode).toBe(0)
      }
      const alternateTls = await unrestricted.runCommand("curl", [
        "--noproxy",
        "*",
        "-sS",
        "--max-time",
        "5",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "https://www.cloudflare.com:8443",
      ])
      expect(alternateTls.exitCode).toBe(0)
      expect(Number(alternateTls.stdout)).toBeGreaterThanOrEqual(100)
    } finally {
      await unrestricted.destroy()
    }
    const sandbox = await factory().create({
      network: {
        mode: "restricted",
        allow: [
          { name: "allowed", origin: "https://example.com" },
          { name: "ports", origin: "https://portquiz.net" },
          { name: "tls-ports", origin: "https://www.cloudflare.com" },
        ],
      },
    })
    console.log(`[AzureE2E] Network sandbox ${sandbox.id}`)
    try {
      const allowed = await sandbox.runCommand("node", [
        "-e",
        "fetch('https://example.com').then(async r=>{if(!r.ok)throw Error('denied');console.log(await r.text())})",
      ])
      expect(allowed.exitCode).toBe(0)
      expect(allowed.stdout).toContain("Example Domain")
      // Negative control: change restricted egress to Allow/None. Forbidden-origin checks fail.
      for (const url of ["https://example.org", "http://example.com", "http://portquiz.net:8080"]) {
        const result = await sandbox.runCommand("curl", [
          "--noproxy",
          "*",
          "-fsS",
          "--max-time",
          "5",
          url,
        ])
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).not.toContain("Example Domain")
      }
      const alternateTls = await sandbox.runCommand("curl", [
        "--noproxy",
        "*",
        "-sS",
        "--max-time",
        "5",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "https://www.cloudflare.com:8443",
      ])
      expect(alternateTls.exitCode).not.toBe(0)
      expect(alternateTls.stdout).toBe("000")
      const spoof = await sandbox.runCommand("node", [
        "-e",
        `const https=require('https'); Promise.all([['example.com','example.com','example.org'],['example.org','example.com','example.org'],['example.org','example.org','example.com']].map(([hostname,servername,host])=>new Promise((resolve,reject)=>{https.get({hostname,servername,headers:{Host:host},timeout:4000},r=>{r.resume();r.on('end',()=>resolve(r.statusCode))}).on('error',reject)}))).then(r=>console.log(JSON.stringify(r)))`,
      ])
      expect(spoof.exitCode).toBe(0)
      expect(JSON.parse(spoof.stdout)).toEqual([421, 421, 421])
      const ip = await sandbox.runCommand("curl", ["-kfsS", "--max-time", "5", "https://1.1.1.1"])
      expect(ip.exitCode).not.toBe(0)
    } finally {
      await sandbox.destroy()
      console.log(`[AzureE2E] Deleted ${sandbox.id}`)
    }
  },
  180_000
)
