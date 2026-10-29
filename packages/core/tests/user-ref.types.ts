import {
  type CurrentUserRef,
  col,
  currentUser,
  defineAction,
  defineDataset,
  defineObjectType,
  defineProjection,
  type InferObjectProperties,
  type InferSchema,
  type ObjectWhereBuilder,
  type ObjectWhereClause,
  param,
  prop,
  ref,
  type Sixb,
  type UserEmailColumn,
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
    prop("title", "string"),
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

export type CurrentUserInference = [
  Expect<Equal<ReturnType<typeof currentUser>, CurrentUserRef>>,
  Expect<Equal<CurrentUserRef, { readonly type: "currentUser" }>>,
]

export function currentUserPredicates(where: ObjectWhereBuilder<typeof Task>): void {
  where.p.assignee.eq(currentUser())
  where.p.assignee.neq(currentUser())
  where.p.assignee.in([currentUser(), userRef("usr_1"), null])
  where.p.reviewers.contains(currentUser())
  // @ts-expect-error currentUser() only compares with user references
  where.p.title.eq(currentUser())
  // @ts-expect-error a range operator takes the property's own value, never currentUser()
  where.p.assignee.lt(currentUser())
  // @ts-expect-error exists takes a boolean
  where.p.assignee.exists(currentUser())
}

export const handWrittenClauses: readonly ObjectWhereClause<typeof Task>[] = [
  { op: "eq", propertyId: "assignee", value: currentUser() },
  { op: "in", propertyId: "assignee", values: [currentUser()] },
  { op: "contains", propertyId: "reviewers", value: currentUser() },
  // @ts-expect-error only eq, neq, in and contains clauses accept currentUser()
  { op: "lt", propertyId: "assignee", value: currentUser() },
]

declare const sixb: Sixb

export async function currentUserIsNotStorable(): Promise<void> {
  // @ts-expect-error currentUser() is not a user reference: it cannot be stored
  await sixb.objects(Task).upsert({ properties: { id: "t1", assignee: currentUser() } })
  // @ts-expect-error nor stored in a list of them
  await sixb.objects(Task).upsert({ properties: { id: "t1", reviewers: [currentUser()] } })
}

export const assignToCurrentUser = defineAction("assignToCurrentUser")
  .params({ assignee: param(ref.user()) })
  .edits(({ objects }) => {
    // @ts-expect-error an edit cannot store currentUser() either
    objects(Task).create({ id: "t1", assignee: currentUser() })
  })

const tasks = defineDataset("tasks", {
  schema: [
    col("task_id", "string"),
    col("title", "string"),
    col("assignee_email", "string", { nullable: true }),
    col("assignee_count", "int64"),
  ],
})

const AssignedTask = defineObjectType({
  id: "AssignedTask",
  name: "Assigned task",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("assignee", ref.user(), { required: true }),
  ],
})

export type UserEmailColumnInference = [
  Expect<
    Equal<ReturnType<typeof userRef.fromEmail<"assignee_email">>, UserEmailColumn<"assignee_email">>
  >,
]

export function userEmailMappings(): void {
  defineProjection("tasks", Task)
    .fromDataset(tasks)
    .properties({ id: "task_id", title: "title", assignee: userRef.fromEmail("assignee_email") })

  defineProjection("tasks", Task)
    .fromDataset(tasks)
    // @ts-expect-error member emails come from a string column
    .properties({ id: "task_id", assignee: userRef.fromEmail("assignee_count") })

  defineProjection("tasks", Task)
    .fromDataset(tasks)
    // @ts-expect-error only a ref.user() property resolves a member
    .properties({ id: "task_id", title: userRef.fromEmail("assignee_email") })

  defineProjection("tasks", Task)
    .fromDataset(tasks)
    // @ts-expect-error a list of user references has no email column form
    .properties({ id: "task_id", reviewers: userRef.fromEmail("assignee_email") })

  defineProjection("tasks", AssignedTask)
    .fromDataset(tasks)
    // @ts-expect-error an email no member has would leave a required property empty
    .properties({ id: "task_id", assignee: userRef.fromEmail("assignee_email") })
}
