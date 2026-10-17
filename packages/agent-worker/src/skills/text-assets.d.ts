// The built-in skills' files, and the scripts the worker runs in the sandbox, are bundled as text.
declare module "*.md" {
  const text: string
  export default text
}

declare module "*.svg" {
  const text: string
  export default text
}

declare module "*.csv" {
  const text: string
  export default text
}

declare module "*.cjs" {
  const text: string
  export default text
}
