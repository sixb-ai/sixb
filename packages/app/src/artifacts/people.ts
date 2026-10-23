import { createContext, useContext } from "react"

/** Someone who published a version, as the API names them. */
export interface ArtifactAuthor {
  readonly type: string
  readonly id: string
}

/**
 * Names for the people of the conversation an artifact opens in, so its versions say who made
 * them. Outside a conversation nobody is named but the reader.
 */
export const ArtifactPeopleContext = createContext<(author: ArtifactAuthor) => string | undefined>(
  () => undefined
)

export function useArtifactPeople(): (author: ArtifactAuthor) => string | undefined {
  return useContext(ArtifactPeopleContext)
}
