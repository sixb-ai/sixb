import { InMemoryActivityStorage } from "../src/storage/activity"
import { InMemoryStorage } from "../src/storage/in-memory"
import { runActivityStorageContractSuite } from "../src/testing"

runActivityStorageContractSuite("InMemoryActivityStorage", {
  createStorage: () => new InMemoryStorage(),
  // The in-memory store has no delete; its snapshot is edited instead.
  deleteVisit: async (storage, visit) => {
    const activity: unknown = Reflect.get(storage, "activityStorage")
    if (!(activity instanceof InMemoryActivityStorage)) {
      throw new Error("Expected the in-memory activity store.")
    }

    const snapshot = activity.snapshot()
    snapshot.visits.delete(JSON.stringify([visit.projectId, visit.id]))
    activity.restore({
      ...snapshot,
      pageViews: snapshot.pageViews.filter(
        (pageView) => pageView.projectId !== visit.projectId || pageView.visitId !== visit.id
      ),
      interactions: snapshot.interactions.filter(
        (interaction) =>
          interaction.projectId !== visit.projectId || interaction.visitId !== visit.id
      ),
    })
  },
})
