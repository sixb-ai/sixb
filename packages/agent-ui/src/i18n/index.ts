import { defineMessages, type Labels } from "@sixb/ui/lib/i18n"
import { type AgentMessages, en } from "./en"
import { fr } from "./fr"

const agentMessages = defineMessages<AgentMessages>({ en, fr })

/** Messages of the agent chat in the current locale, with any labels supplied above. */
export const useAgentMessages = agentMessages.useMessages

/** Rewords the agent chat below it, in every language. */
export const AgentLabelsProvider = agentMessages.LabelsProvider

export type AgentLabels = Labels<AgentMessages>
export type { AgentMessages }
