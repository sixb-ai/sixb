import { defineMessages, type Labels } from "./messages"
import { en, type UiMessages } from "./messages/en"
import { fr } from "./messages/fr"

const uiMessages = defineMessages<UiMessages>({ en, fr })

/** Messages of `@sixb/ui` components in the current locale. */
export const useUiMessages = uiMessages.useMessages

/** Rewords `@sixb/ui` components below it, in every language. */
export const UiLabelsProvider = uiMessages.LabelsProvider

export type UiLabels = Labels<UiMessages>
