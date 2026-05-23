import { describe, expect, test } from "bun:test"
import {
  col,
  defineDataset,
  defineObjectType,
  defineProjection,
  OntologyRegistry,
  prop,
} from "@sixb/core"
import { buildObjectProjectionPlan, projectObjectRow } from "../src/object-projection-plan"

describe("object projection plan", () => {
  test("validates original dataset row before numeric projection coercion", () => {
    const Meter = defineObjectType({
      id: "Meter",
      name: "Meter",
      properties: [
        prop("id", "string", { required: true, primary: true }),
        prop("reading", "double"),
      ],
    })
    const readingsDataset = defineDataset("canonical.meter-readings", {
      schema: [col("meter_id", "string"), col("reading", "float64")],
    })
    const readingProjection = defineProjection("meter-reading-proj", Meter)
      .fromDataset(readingsDataset)
      .properties({ id: "meter_id", reading: "reading" })
    const ontology = new OntologyRegistry({ sources: [Meter] })
    const plan = buildObjectProjectionPlan({
      ontology,
      projection: readingProjection,
      dataset: readingsDataset,
      primaryPropertyId: ontology.getPrimaryPropertyId("Meter"),
    })

    expect(projectObjectRow(plan, { meter_id: "m1", reading: "1.5" })).toEqual({
      ok: false,
      errorMessage:
        "Dataset 'canonical.meter-readings' column 'reading' must match type 'float64'.",
    })
  })
})
