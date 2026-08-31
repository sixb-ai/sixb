import { createContext, createElement, type ReactNode, useContext } from "react"
import type { Client } from "./generated/client"

const SixbClientContext = createContext<Client | undefined>(undefined)

export function SixbProvider(props: { client: Client; children?: ReactNode }) {
  return createElement(SixbClientContext.Provider, { value: props.client }, props.children)
}

export function useSixbProviderClient(): Client | undefined {
  return useContext(SixbClientContext)
}
