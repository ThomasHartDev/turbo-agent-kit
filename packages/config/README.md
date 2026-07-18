# @agent/config

Zod-validated environment loading for the workspace. One schema per service, validated once at the process boundary, so the rest of the code works with a typed, frozen config object instead of reaching into `process.env` and hoping the string is set.

## Why

`process.env` is `string | undefined` everywhere, which means every consumer either re-parses or trusts a value that may be missing. This centralizes that: coerce the strings into real types, validate the whole set at startup, and fail with every problem at once rather than crashing on the third missing variable an hour into a deploy.

## What it does

- **Coercion helpers** (`env.bool`, `env.integer`, `env.port`, `env.url`, `env.nonEmpty`, `env.oneOf`) that turn env strings into typed values with explicit accepted spellings. `bool` reads `true/false/1/0/yes/no/on/off`; `port` enforces the 1-65535 range.
- **Fail-fast with aggregation**: `loadConfig` collects every invalid or missing variable into a single `ConfigError`, and separates "set but wrong" from "never set" in the message.
- **Secret redaction**: variables named in `secrets` are masked in both the error output and the `redacted()` view, so a bad `DATABASE_URL` never prints a password to the logs.
- **Immutable result**: the parsed config is `Object.freeze`d so nothing mutates it after startup.

## Usage

```ts
import { loadConfig, env } from "@agent/config";

const config = loadConfig(
  {
    NODE_ENV: env.oneOf(["development", "production", "test"]).default("development"),
    PORT: env.port().default(3000),
    DEBUG: env.bool().default(false),
    DATABASE_URL: env.url(),
    OPENAI_API_KEY: env.nonEmpty(),
  },
  { secrets: ["OPENAI_API_KEY"] },
);

config.values.PORT; // number, 3000
config.redacted(); // { ..., OPENAI_API_KEY: "[redacted]" }
```

If `PORT=abc` and `DATABASE_URL` is missing, the throw reads:

```
Invalid configuration:
  PORT: Too small: expected number to be >=1 (received "abc")
  DATABASE_URL: required but not set
```

The helpers are plain Zod schemas, so an object built from them still composes with `.refine`, `.transform`, and the rest of Zod.

## Tests

```
pnpm --filter @agent/config test
```
