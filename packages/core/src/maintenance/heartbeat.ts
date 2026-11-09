import type { MaintenanceLoopOwner, Storage } from "../storage"
import type { MaintenanceHeartbeat } from "./loop"

/** Where a maintenance loop beats. A storage without heartbeats leaves the loop silent. */
export function storageHeartbeat(
  projectId: string,
  owner: MaintenanceLoopOwner,
  storage: Pick<Storage, "maintenanceHeartbeats">
): MaintenanceHeartbeat | undefined {
  const heartbeats = storage.maintenanceHeartbeats
  if (!heartbeats) return undefined

  return { write: (beat) => heartbeats.record({ ...beat, projectId, owner }) }
}
