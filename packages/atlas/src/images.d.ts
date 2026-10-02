// Bun's bundler emits an imported image as a file and resolves the import to its URL.
declare module "*.ico" {
  const url: string
  export default url
}

declare module "*.png" {
  const url: string
  export default url
}

declare module "*.svg" {
  const url: string
  export default url
}
