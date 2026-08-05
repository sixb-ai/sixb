export type QueryScalar = string | number | boolean
export type QueryValue = QueryScalar | readonly QueryScalar[] | undefined
export type QueryParams = Readonly<Record<string, QueryValue>>
