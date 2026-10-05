export interface PlaudUser {
  id: string
  email: string
  nickname: string
  avatar: string | null
  workspace_id?: string
  member_id?: string
  [key: string]: unknown
}
