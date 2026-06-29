import { events, useInvalidateOnEvent } from "@sixb/client/hooks"
import {
  objectDetailKey,
  queryKey,
  queryKeyWithPath,
  sameObject,
} from "../../../lib/liveUpdateKeys"

const debounceMs = 100

export function useRuleLiveUpdates(
  options: {
    enabled?: boolean
    ruleId?: string
    subject?: { readonly objectTypeId: string; readonly primaryId: string }
  } = {}
) {
  useInvalidateOnEvent(
    events.rules(),
    (event) => {
      if (options.ruleId && event.payload.ruleId !== options.ruleId) return []
      if (options.subject && !sameObject(event.payload.subject, options.subject)) return []

      return [
        queryKey("listRules"),
        queryKey("listRuleStates"),
        queryKeyWithPath("getRule", { ruleId: event.payload.ruleId }),
        objectDetailKey(event.payload.subject.objectTypeId, event.payload.subject.primaryId),
      ]
    },
    { enabled: options.enabled ?? true, debounceMs }
  )
}
