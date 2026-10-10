import { z } from "zod"

export const ProjectInfoResponseSchema = z.object({
  id: z.string(),
  /** Canonical BCP 47 language of the project, `"en"` unless configured. */
  locale: z.string(),
  /** Canonical IANA time zone of the project, `"UTC"` unless configured. */
  timeZone: z.string(),
})
