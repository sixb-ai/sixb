import { defineConfig } from "@hey-api/openapi-ts"

export default defineConfig({
  input: "./openapi.json",
  output: {
    path: "./src/generated",
  },
  plugins: [
    "@hey-api/typescript",
    {
      name: "@hey-api/sdk",
      client: "@hey-api/client-fetch",
    },
    {
      name: "@tanstack/react-query",
      queryOptions: true,
      mutationOptions: true,
    },
  ],
})
