import { beforeAll, expect, test } from "bun:test"
import { AzureSandboxFactory } from "../src"
import { buildGuestArtifact } from "./guest-build"

const enabled = process.env.SIXB_AZURE_E2E === "1"
beforeAll(async () => {
  if (enabled) await buildGuestArtifact()
}, 20_000)

test.skipIf(!enabled)(
  "Azure file bytes, modes, containment and concurrent workload mutation",
  async () => {
    const sandbox = await new AzureSandboxFactory({
      subscriptionId: process.env.AZURE_SUBSCRIPTION_ID!,
      resourceGroup: process.env.AZURE_RESOURCE_GROUP!,
      sandboxGroup: process.env.AZURE_SANDBOX_GROUP!,
      region: process.env.AZURE_SANDBOX_REGION ?? "westus3",
      image: { type: "public", name: "node-22" },
      resources: { vcpus: 1, memoryMiB: 2048, diskGiB: 20 },
      timeout: 30_000,
      pollIntervalMs: 200,
    }).create()
    console.log(`[AzureFilesE2E] Created ${sandbox.id}`)
    const node = (source: string) => sandbox.runCommand("node", ["-e", source])
    try {
      const bytes = new Uint8Array([99, 0, 255, 254, 10, 99]).subarray(1, 5)
      await sandbox.writeFiles([
        { path: "nested/雪 'quoted.txt", contents: "héllo\n" },
        { path: "nested/binary", contents: bytes, mode: 0o640 },
        { path: "script", contents: "#!/bin/sh\nprintf executable", mode: 0o755 },
        { path: "empty", contents: new Uint8Array() },
      ])
      const read = await node(
        `const f=require('node:fs');console.log(JSON.stringify({text:f.readFileSync("nested/雪 'quoted.txt",'utf8'),bytes:[...f.readFileSync('nested/binary')],mode:f.statSync('nested/binary').mode&4095,owner:f.statSync('nested/binary').uid,empty:f.statSync('empty').size}))`
      )
      expect(JSON.parse(read.stdout)).toEqual({
        text: "héllo\n",
        bytes: [...bytes],
        mode: 0o640,
        owner: 65534,
        empty: 0,
      })
      expect((await sandbox.runCommand("./script")).stdout).toBe("executable")
      await sandbox.writeFiles([
        { path: "/workspace/nested/binary", contents: "replacement" },
        { path: "empty", contents: "now populated" },
      ])
      expect(
        (
          await node(
            "const f=require('node:fs');console.log(f.readFileSync('nested/binary','utf8'),f.statSync('nested/binary').mode&4095)"
          )
        ).stdout.trim()
      ).toBe("replacement 416")
      await sandbox.writeFiles([{ path: "empty", contents: "" }])
      expect(
        (await node("console.log(require('node:fs').statSync('empty').size)")).stdout.trim()
      ).toBe("0")
      await sandbox.writeFiles([])
      console.log("[AzureFilesE2E] bytes, ownership, executable modes and overwrite passed")

      await node(
        "const f=require('node:fs');f.mkdirSync('/tmp/sixb-outside');f.writeFileSync('/tmp/sixb-outside/sentinel','untouched',{mode:384});f.symlinkSync('/tmp/sixb-outside','escape');f.symlinkSync('/tmp/sixb-outside/sentinel','leaf');f.linkSync('/tmp/sixb-outside/sentinel','hard')"
      )
      await expect(sandbox.writeFiles([{ path: "../outside", contents: "bad" }])).rejects.toThrow(
        "escapes"
      )
      for (const path of ["escape/sentinel", "leaf"]) {
        await expect(sandbox.writeFiles([{ path, contents: "bad" }])).rejects.toThrow("symlink")
      }
      await sandbox.writeFiles([{ path: "hard", contents: "new", mode: 0o755 }])
      expect(
        (
          await node(
            "const f=require('node:fs');console.log(f.readFileSync('/tmp/sixb-outside/sentinel','utf8'),f.statSync('/tmp/sixb-outside/sentinel').mode&4095)"
          )
        ).stdout.trim()
      ).toBe("untouched 384")
      expect(
        (await node("console.log(require('node:fs').readFileSync('hard','utf8'))")).stdout.trim()
      ).toBe("new")
      console.log("[AzureFilesE2E] symlink and hard-link containment passed; session reusable")

      // The workload actively alternates a parent directory and a symlink to an
      // outside directory. Publication must either reject or write safely inside.
      await node("require('node:fs').mkdirSync('race')")
      const abort = new AbortController()
      const racing = sandbox.runCommand(
        "node",
        [
          "-e",
          `const f=require('node:fs');f.writeFileSync('race-ready','1');for(;;){try{f.renameSync('race','parked');f.symlinkSync('/tmp/sixb-outside','race');f.unlinkSync('race');f.renameSync('parked','race')}catch{try{f.rmSync('race',{recursive:true,force:true})}catch{};try{f.renameSync('parked','race')}catch{f.mkdirSync('race',{recursive:true})}}}`,
        ],
        { signal: abort.signal, timeout: 60_000 }
      )
      const observed = racing.then(
        (result) => ({ result }),
        (error: unknown) => ({ error })
      )
      try {
        for (let i = 0; i < 20; i++) {
          if ((await sandbox.runCommand("test", ["-e", "race-ready"])).exitCode === 0) break
          if (i === 19) throw new Error("race workload did not start")
        }
        for (let i = 0; i < 5; i++) {
          try {
            await sandbox.writeFiles([{ path: "race/sentinel", contents: `attempt ${i}` }])
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes("symlink")) throw error
          }
        }
      } finally {
        abort.abort()
      }
      const outcome = await observed
      if ("error" in outcome) throw outcome.error
      expect(outcome.result.exitCode).toBe(137)
      expect(
        (
          await node(
            "console.log(require('node:fs').readFileSync('/tmp/sixb-outside/sentinel','utf8'))"
          )
        ).stdout.trim()
      ).toBe("untouched")
      await sandbox.writeFiles([{ path: "after-race", contents: "healthy" }])
      expect((await sandbox.runCommand("cat", ["after-race"])).stdout).toBe("healthy")
      console.log("[AzureFilesE2E] concurrent path mutation contained; workloads thawed")

      await sandbox.stop()
      await expect(sandbox.writeFiles([])).rejects.toThrow("stopped")
    } finally {
      await sandbox.destroy()
      console.log(`[AzureFilesE2E] Deleted ${sandbox.id}`)
    }
  },
  180_000
)
