/**
 * Relating SDK types stays within TypeScript's limits.
 *
 * Each case is code an app wrote and had to cast around: relating the builders, rows or runtime
 * façades involved made TypeScript measure their variance, and the probe re-entered the schema
 * inference until it overflowed (TS2589). Object types now carry their inferred property values,
 * and rows read them back instead of inferring them again.
 *
 * Guards, each case checked alone with TypeScript 5.9.3 (`bun run typecheck:tests`):
 * - make `TwinObject` (packages/core/src/runtime/types.ts) read `InferObjectProperties` instead of
 *   `ObjectTypeProperties`: both reassignments, the shared read helper and the loose row fail with
 *   TS2589;
 * - make `ObjectPropertiesMetadata` (packages/core/src/ontology/tokens.ts) hold
 *   `InferObjectProperties` instead of `ObjectPropertiesCarrier`: the incoming reassignment and the
 *   expanded query fail with TS2589.
 */
import { objects } from "@sixb/client/query"
import type {
  ActionReadFacade,
  ObjectQueryBuilder,
  ObjectReader,
  ObjectTypeWithPropertyTokens,
  Sixb,
  TwinObject,
  WorkflowRuntimeFacade,
} from "@sixb/core"
import { Contact, EmailMessage, EmailThread, Project } from "./ontology/correspondence"

declare const workflow: WorkflowRuntimeFacade
declare const read: ActionReadFacade
declare const sixb: Sixb

// ── A query reassigned from another root ───────────────────────────────────

export function messagesQuery(projectId: string, status: "assigned" | "needs_review") {
  let messages = objects(EmailMessage).query()
  if (projectId) {
    messages = objects(Project)
      .query()
      .where((project) => project.p.id.eq(projectId))
      .traverse(EmailMessage.l.projects, { direction: "incoming" })
  }
  return messages.where((message) => message.p.assignmentStatus.eq(status))
}

export function threadsQuery(messageId: string) {
  let threads = objects(EmailThread).query()
  if (messageId) {
    // Through a direct link, the target resolves to the registered type, the one `objects()` got.
    // Guard: resolve direct targets before the registry (`ObjectTypeForLinkTarget` in
    // runtime/types.ts) and this reassignment fails.
    threads = objects(EmailMessage)
      .query()
      .where((message) => message.p.id.eq(messageId))
      .traverse(EmailMessage.l.thread)
  }
  return threads
}

// ── One read helper for an Action, a Workflow step and the runtime ─────────

function messagesToReview(reader: ObjectReader) {
  return reader
    .objects(EmailMessage)
    .query()
    .where((message) => message.p.assignmentStatus.eq("needs_review"))
    .list()
}
export const sharedReads = [
  messagesToReview(read),
  messagesToReview(workflow),
  messagesToReview(sixb),
]

// ── An expanded query passed where the plain query is expected ─────────────

function latestMessage(messages: ObjectQueryBuilder<typeof EmailMessage>) {
  return messages.orderBy(EmailMessage.p.sentAt, "desc").first()
}
export const latestExpanded = latestMessage(
  objects(EmailMessage).query().expand(EmailMessage.l.from).expand(EmailMessage.l.projects)
)

// ── Rows ───────────────────────────────────────────────────────────────────

export async function looseContact(): Promise<TwinObject<ObjectTypeWithPropertyTokens> | null> {
  // A row of an object type is a row of the loose base type.
  return workflow.objects(Contact).get("contact-1")
}
