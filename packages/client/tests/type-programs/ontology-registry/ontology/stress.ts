import { defineObjectType, link, prop } from "@sixb/core/ontology"

export const StressDepartment = defineObjectType({
  id: "StressDepartment",
  name: "Department",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

export const StressSkill = defineObjectType({
  id: "StressSkill",
  name: "Skill",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
})

export const StressUser = defineObjectType({
  id: "StressUser",
  name: "User",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("email", "string", { required: true }),
  ],
  links: [
    link.self("manager", { cardinality: "one" }),
    link("department", StressDepartment, { cardinality: "one" }),
    link("skills", StressSkill, { cardinality: "many" }),
  ],
})

export const StressTeam = defineObjectType({
  id: "StressTeam",
  name: "Team",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("slug", "string", { required: true }),
  ],
  links: [link("members", StressUser, { cardinality: "many" })],
})

export const StressProject = defineObjectType({
  id: "StressProject",
  name: "Project",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
  links: [link.ref("owner", ["StressUser", "StressTeam"], { cardinality: "one" })],
})

export const StressFolder = defineObjectType({
  id: "StressFolder",
  name: "Folder",
  properties: [
    prop("id", "string", { required: true, primary: true }),
    prop("name", "string", { required: true }),
  ],
  links: [
    link.self("parent", { cardinality: "one" }),
    link.self("children", { cardinality: "many" }),
  ],
})
