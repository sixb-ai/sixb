// What `sandbox-cli.ts` imports as text. Bun's loader reads them; the type checker needs telling.
declare module "*/bin/sixb" {
  const text: string
  export default text
}

declare module "*/generated/sixb.mjs" {
  const text: string
  export default text
}
