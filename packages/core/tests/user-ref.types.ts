import {
  defineObjectType,
  type InferObjectProperties,
  type InferSchema,
  type ObjectWhereBuilder,
  prop,
  ref,
  type UserRef,
  userRef,
} from "../src"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const Task = defineObjectType({
  id: "Task",
  name: "Task",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("assignee", ref.user(), { nullable: true }),
    prop("reviewers", { type: "array", items: ref.user() }),
  ],
})

type TaskProperties = InferObjectProperties<typeof Task>

export type UserRefInference = [
  Expect<Equal<ReturnType<typeof ref.user>, "userRef">>,
  Expect<Equal<ReturnType<typeof ref.file>, "fileRef">>,
  Expect<Equal<UserRef, { readonly type: "user"; readonly id: string }>>,
  Expect<Equal<InferSchema<"userRef">, UserRef>>,
  Expect<Equal<ReturnType<typeof userRef>, UserRef>>,
  Expect<Equal<TaskProperties["assignee"], UserRef | null | undefined>>,
  Expect<Equal<TaskProperties["reviewers"], UserRef[] | undefined>>,
]

export function userRefPredicates(where: ObjectWhereBuilder<typeof Task>): void {
  where.p.assignee.eq({ type: "user", id: "usr_1" })
  where.p.assignee.in([userRef("usr_1"), null])
  where.p.reviewers.contains({ type: "user", id: "usr_1" })
  // @ts-expect-error a user reference is not a bare id
  where.p.assignee.eq("usr_1")
}
