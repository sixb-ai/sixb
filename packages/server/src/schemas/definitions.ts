import { DEFINITION_KINDS } from "@sixb/core/internal/manifest"
import { z } from "zod"
import { DatasetColumnSchema, DatasetDefinitionSchema } from "./datasets"

export const ManifestDefinitionSchema = z.object({
  kind: z.enum(DEFINITION_KINDS),
  id: z.string(),
  /** The project file that declares it, or null for one passed to `createSixb` directly. */
  file: z.string().nullable(),
  hash: z.string(),
})

export const ManifestProjectionSchema = z.object({
  id: z.string(),
  /** Changes whenever the projection would rebuild on deploy. */
  revision: z.string(),
})

export const ManifestDatasetSchema = DatasetDefinitionSchema.extend({
  kind: z.literal("dataset"),
  schema: z.object({
    columns: z.array(DatasetColumnSchema.extend({ markings: z.array(z.string()).optional() })),
  }),
})

export const DefinitionsManifestSchema = z.object({
  /** The commit the runtime was deployed from, or null outside a deploy. */
  commit: z.string().nullable(),
  hash: z.string(),
  definitions: z.array(ManifestDefinitionSchema),
  projections: z.array(ManifestProjectionSchema),
  datasets: z.array(ManifestDatasetSchema),
})
