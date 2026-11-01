# Environment variables

List the variables your project needs in `sixb.env.ts`, so a missing one is named before anything runs. The file holds names only, so commit it.

```ts
import { defineEnv } from "@sixb/core/env"

export default defineEnv({
  vars: {
    DATABASE_URL: "required",
    LINKEDIN_CLIENT_SECRET: "prod",
    SENTRY_DSN: "optional",
  },
})
```

| Rule | The variable must have a value |
| --- | --- |
| `required` | Everywhere |
| `prod` | When `NODE_ENV` is `production` |
| `optional` | Never. The name is only recorded |

`sixb dev` and `sixb check` stop before starting when a variable has no value, and an empty value counts as none:

```text
Missing DATABASE_URL, which sixb.env.ts requires.
Add what's missing to the project's .env.
```

A project without `sixb.env.ts` runs without these checks.
