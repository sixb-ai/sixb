import { decodeObjectId } from "@sixb/client"
import { events, useInvalidateOnEvent } from "@sixb/client/hooks"
import {
  objectChangedKeys,
  objectDetailKey,
  relationshipKey,
  sameObject,
} from "../../../lib/liveUpdateKeys"

const debounceMs = 100

export function useObjectLiveUpdates(
  options: { enabled?: boolean; objectId?: string | null } = {}
) {
  const subject = options.objectId ? decodeObjectId(options.objectId) : null
  const enabled = (options.enabled ?? true) && (options.objectId ? subject !== null : true)

  useInvalidateOnEvent(
    events.objects(),
    (event) => {
      const changed = {
        objectTypeId: event.payload.objectTypeId,
        primaryId: event.payload.primaryId,
      }
      if (subject && !sameObject(changed, subject)) return []
      return objectChangedKeys(event.payload.objectTypeId, event.payload.primaryId)
    },
    { enabled, debounceMs }
  )

  useInvalidateOnEvent(
    events.links(),
    (event) => {
      const source = {
        objectTypeId: event.payload.sourceTypeId,
        primaryId: event.payload.sourceId,
      }
      const target = {
        objectTypeId: event.payload.targetTypeId,
        primaryId: event.payload.targetId,
      }
      if (subject && !sameObject(source, subject) && !sameObject(target, subject)) return []

      return [
        objectDetailKey(event.payload.sourceTypeId, event.payload.sourceId),
        objectDetailKey(event.payload.targetTypeId, event.payload.targetId),
        relationshipKey(event.payload.sourceTypeId, event.payload.sourceId),
        relationshipKey(event.payload.targetTypeId, event.payload.targetId),
      ]
    },
    { enabled, debounceMs }
  )
}
