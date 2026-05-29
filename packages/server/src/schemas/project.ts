import { z } from "zod"

export const ProjectInfoResponseSchema = z.object({
  id: z.string(),
})
