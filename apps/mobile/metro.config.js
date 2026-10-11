// Expo configures Metro for the Bun workspace (watch folders, node_modules lookup) on its own.
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)

// Sixb's workspace packages export their TypeScript source under the `bun` condition, which is how
// Atlas reads them. Resolve `@sixb/*` the same way, so the app runs without building the packages.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolution = moduleName.startsWith("@sixb/")
    ? { ...context, unstable_conditionNames: [...context.unstable_conditionNames, "bun"] }
    : context
  return context.resolveRequest(resolution, moduleName, platform)
}

module.exports = config
