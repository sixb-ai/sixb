import type { PandaDocJsonObject } from "./common"

export interface PandaDocContactListOptions {
  /** Optional exact-match email filter. */
  readonly email?: string
}

export interface PandaDocContact extends PandaDocJsonObject {
  readonly id: string
  readonly email?: string | null
  readonly first_name?: string | null
  readonly last_name?: string | null
  readonly company?: string | null
  readonly job_title?: string | null
  readonly phone?: string | null
  readonly country?: string | null
  readonly state?: string | null
  readonly street_address?: string | null
  readonly city?: string | null
  readonly postal_code?: string | null
}

export interface PandaDocContactInput extends PandaDocJsonObject {
  readonly email: string
  readonly first_name?: string | null
  readonly last_name?: string | null
  readonly company?: string | null
  readonly job_title?: string | null
  readonly phone?: string | null
  readonly country?: string | null
  readonly state?: string | null
  readonly street_address?: string | null
  readonly city?: string | null
  readonly postal_code?: string | null
}
