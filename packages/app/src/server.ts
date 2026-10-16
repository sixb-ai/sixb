/**
 * The custom app's dev server, production build, and serving, for the `sixb` CLI.
 *
 * Runs only in Bun. App code imports `@sixb/app`, which never reaches this module, so none of it
 * enters the browser bundle.
 */
export {
  AppPackagesMissingError,
  type CreateCustomAppOptions,
  type CustomAppBuildOptions,
  type CustomAppDevOptions,
  type CustomAppDevServer,
  type CustomAppInstance,
  type CustomAppServer,
  type CustomAppStartOptions,
  type CustomAuthExperienceBuildOptions,
  type CustomAuthExperienceBuildResult,
  createCustomApp,
} from "./createCustomApp"
