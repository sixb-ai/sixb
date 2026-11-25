import { z } from "zod"

export const ProjectInfoResponseSchema = z.object({
  id: z.string(),
  /** Canonical BCP 47 language of the project, `"en"` unless configured. */
  locale: z.string(),
  /** Canonical IANA time zone of the project, `"UTC"` unless configured. */
  timeZone: z.string(),
  /** The git branch this app runs as, on a copy of production's data. Absent in production. */
  branch: z
    .object({
      name: z.string(),
      /** When production took the copy, when the branch knows. */
      dataTakenAt: z.string().nullable(),
      /** Production's app, on a branch production runs that knows it: the banner links back. */
      productionUrl: z.string().nullable(),
    })
    .optional(),
})
