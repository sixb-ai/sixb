import { defineMigration, defineObjectType, prop } from "../src"

const Job = defineObjectType({
  id: "Job",
  name: "Job",
  properties: [
    prop("ref", "string", { required: true, primary: true }),
    prop("gateCode", "string"),
    prop("hours", "double", { required: true }),
  ],
})

// `from` is no longer declared, so any string goes; `to` is one of the type's properties.
defineMigration("job-gate", Job).renameProperty("gate", "gateCode")
// @ts-expect-error `to` must be declared on the type
defineMigration("job-gate", Job).renameProperty("gate", "gateId")

// A value function returns the property's value type.
defineMigration("job-hours", Job)
  .fillProperty("hours", () => 0)
  .convertProperty("hours", ({ value }) => Number(value))
// @ts-expect-error `hours` is a double
defineMigration("job-hours", Job).convertProperty("hours", () => "3")
// @ts-expect-error only declared properties are filled
defineMigration("job-crew", Job).fillProperty("crewLead", () => "x")

// The id and the type's id stay literal, for whoever reads the definition back.
const migration = defineMigration("job-gate", Job).removeProperty("gate")
const id: "job-gate" = migration.id
const objectTypeId: "Job" = migration.objectTypeId
void id
void objectTypeId
