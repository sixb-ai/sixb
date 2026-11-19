// What `hyperframes.ts` imports as text. Bun's loader reads it; the type checker needs telling.
declare module "*/generated/hyperframes.txt" {
  const text: string
  export default text
}
