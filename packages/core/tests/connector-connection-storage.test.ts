import { InMemoryStorage } from "../src/storage/in-memory"
import { runConnectorConnectionStorageContractSuite } from "../src/testing"

type TestStorage = InMemoryStorage & {
  advanceTime(durationMs: number): void
}

runConnectorConnectionStorageContractSuite("InMemoryConnectorConnectionStorage", {
  createStorage: (): TestStorage => {
    let now = new Date("2026-08-24T12:00:00.000Z")
    return Object.assign(new InMemoryStorage({ connectorConnections: { now: () => now } }), {
      advanceTime(durationMs: number): void {
        now = new Date(now.getTime() + durationMs)
      },
    })
  },
  advanceTime: (storage, durationMs) => storage.advanceTime(durationMs),
})
