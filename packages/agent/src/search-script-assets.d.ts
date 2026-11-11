// What `search-script.ts` imports as text. Bun's loader reads it; the type checker needs telling.
declare module "*/generated/search.mjs" {
  const text: string
  export default text
}
