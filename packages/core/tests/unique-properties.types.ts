import {
  defineObjectType,
  type ObjectReader,
  prop,
  ref,
  type TwinObject,
  type UniquePropertyToken,
  userRef,
} from "../src"

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Expect<T extends true> = T

const Person = defineObjectType({
  id: "Person",
  name: "Person",
  properties: [
    prop("id", "string", { primary: true, required: true }),
    prop("email", "string", { unique: true }),
    prop("account", ref.user(), { nullable: true, unique: true }),
    prop("birthDate", "date", { unique: true }),
    prop("name", "string"),
  ],
})

export type UniqueTokens = Expect<
  Equal<
    UniquePropertyToken<typeof Person>,
    typeof Person.p.email | typeof Person.p.account | typeof Person.p.birthDate
  >
>

export async function lookUp(reader: ObjectReader) {
  const people = reader.objects(Person)

  const byEmail = await people.getBy(Person.p.email, "ada@example.com")
  type _ByEmail = Expect<Equal<typeof byEmail, TwinObject<typeof Person> | null>>

  await people.getBy(Person.p.account, userRef("usr_1"))
  await people.getBy(Person.p.birthDate, new Date())
  await people.getBy(Person.p.birthDate, "1990-01-02")

  // @ts-expect-error `name` is not unique
  await people.getBy(Person.p.name, "Ada")
  // @ts-expect-error null belongs to no object
  await people.getBy(Person.p.account, null)
  // @ts-expect-error an email is a string
  await people.getBy(Person.p.email, 42)
}
