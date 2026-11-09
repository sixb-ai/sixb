import {
  type ArtifactRef,
  artifactRef,
  defineAction,
  defineObjectType,
  type InferObjectProperties,
  type InferSchema,
  type ObjectWhereBuilder,
  param,
  prop,
  ref,
} from "../src"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const Meeting = defineObjectType({
  id: "Meeting",
  name: "Meeting",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("kickoffDoc", ref.artifact(), { nullable: true }),
    prop("attachments", { type: "array", items: ref.artifact() }),
  ],
})

type MeetingProperties = InferObjectProperties<typeof Meeting>

export type ArtifactRefInference = [
  Expect<Equal<ReturnType<typeof ref.artifact>, "artifactRef">>,
  Expect<Equal<ArtifactRef, { readonly type: "artifact"; readonly id: string }>>,
  Expect<Equal<InferSchema<"artifactRef">, ArtifactRef>>,
  Expect<Equal<ReturnType<typeof artifactRef>, ArtifactRef>>,
  Expect<Equal<MeetingProperties["kickoffDoc"], ArtifactRef | null | undefined>>,
  Expect<Equal<MeetingProperties["attachments"], ArtifactRef[] | undefined>>,
]

export function artifactRefPredicates(where: ObjectWhereBuilder<typeof Meeting>): void {
  where.p.kickoffDoc.eq(artifactRef("art_k3m9q2x7tp"))
  where.p.kickoffDoc.in([{ type: "artifact", id: "art_k3m9q2x7tp" }, null])
  where.p.attachments.contains(artifactRef("art_k3m9q2x7tp"))
  // @ts-expect-error an artifact reference is not a bare id
  where.p.kickoffDoc.eq("art_k3m9q2x7tp")
}

export const attachKickoff = defineAction("attachKickoff")
  .on(Meeting)
  .params({ doc: param(ref.artifact()) })
  .validate(({ target, params }) => {
    type _doc = Expect<Equal<typeof params.doc, ArtifactRef>>
    type _kickoffDoc = Expect<Equal<typeof target.properties.kickoffDoc, ArtifactRef | null>>
    type _attachments = Expect<Equal<typeof target.properties.attachments, readonly ArtifactRef[]>>
  })
  .edits(({ objects, params, subject }) => {
    objects(Meeting).byId(subject.primaryId).update({ kickoffDoc: params.doc })
    // @ts-expect-error a meeting holds an artifact reference, not its id
    objects(Meeting).byId(subject.primaryId).update({ kickoffDoc: params.doc.id })
  })
