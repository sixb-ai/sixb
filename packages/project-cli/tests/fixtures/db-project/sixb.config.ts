import { createFixtureSixb } from "../shared/createFixtureSixb"

// A factory: db.test.ts runs both db commands in its own process, and each loads a fresh host.
export const sixb = () =>
  createFixtureSixb({
    projectId: "cli-db-project",
    logStorageMigrate: true,
    logStoragePrepare: true,
  })
