// The script the worker runs in the sandbox, bundled as text.
declare module "*.cjs" {
  const text: string
  export default text
}
