import { afterAll, describe, expect, test } from "bun:test"
import { azureKeyVault } from "../src"

/**
 * Runs against a real vault as whoever `az` is signed in as, who needs to read and write its
 * secrets (Key Vault Secrets Officer). It's skipped without a vault, and it adds one secret and
 * deletes it, which leaves it soft-deleted until the vault purges it:
 *
 *   AZURE_KEY_VAULT_E2E_VAULT=<vault name> bun run test:e2e
 */
const vault = process.env.AZURE_KEY_VAULT_E2E_VAULT
const name = `SIXB_E2E_${crypto.randomUUID().replaceAll("-", "_").toUpperCase()}`

describe.skipIf(!vault)("Azure Key Vault", () => {
  afterAll(async () => {
    const secret = name.replaceAll("_", "-")
    const child = Bun.spawn(
      [
        "az",
        "keyvault",
        "secret",
        "delete",
        "--only-show-errors",
        "--vault-name",
        vault ?? "",
        "--name",
        secret,
      ],
      { stdout: "ignore", stderr: "inherit", timeout: 60_000 }
    )
    await child.exited
  })

  test("a value written can be named and read, without touching the others", async () => {
    const source = azureKeyVault({ vaults: { dev: vault ?? "", prod: vault ?? "" } })
    const before = await source.read("dev")

    await source.write("dev", { [name]: "pa$$word" })

    expect(await source.names("dev")).toContain(name)
    expect(await source.read("dev")).toEqual({ ...before, [name]: "pa$$word" })
  })
})
