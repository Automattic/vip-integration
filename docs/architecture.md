# Architecture

`vip-integration` is a small TypeScript CLI. The design goal is that each piece is independently testable and free of framework glue, so the conformance logic and the scaffolding logic can be exercised without spawning the CLI.

## Layout

```
bin/vip-integration        Launcher shim: requires dist/cli.js and calls run()
src/
  cli.ts                   Commander wiring: defines `init` and `validate`
  commands/
    init.ts                `init` — lay down the Starter Kit, rewrite, report
    validate.ts            `validate` — run the checker, print a report, set exit code
  lib/
    colors.ts              Tiny ANSI helper (chalk-shaped, dependency-free)
    validate/
      validate.ts          Nine conformance checks (pure, fs-only)
      manifest.ts          Handoff-manifest (vip-manifest.yaml) validation
      manifest.schema.ts   JSON Schema: the manifest's fields and constraints
      manifest.fields.ts   Config field checks the schema can't express
      report.ts            Human and JSON rendering of a report
    scaffold/
      scaffold.ts          The Starter Kit prefix rewrite (pure, fs-only)
__tests__/                 Jest tests for validate, report, and scaffold
```

## Command flow

**`init`** collects the vendor and integration names (flags or interactive prompt), and then prepares a boilerplate integration plugin from the `A8C_STARTER_KIT_SOURCE`.

**`validate [path]`** resolves the target directory, confirms it looks like an integration, runs `validateIntegration()`, prints the report (human or JSON), and sets `process.exitCode = 1` when the integration is not conformant.

## The conformance checker (`lib/validate`)

Checks if the integration meets the wpvip guidelines. All checks are **static** — they inspect files and config, never execute the integration. `validateIntegration(root)` builds a single `Context` (parsed `composer.json`, concatenated PHP/docs/workflow text, the detected config constant and entry file, and the parsed handoff manifest) and runs each rule against it, so the filesystem is read once. Rules return `pass` / `fail` / `warn` / `not_applicable`; only a `fail` breaks conformance. Two inherently non-static items (config-schema match, security review) are returned as human-review items.

One rule validates the **handoff manifest** (`vip-manifest.yaml`) — the single file a partner fills in so VIP can register and load the integration from the manifest alone. `manifest.ts` parses it and validates it against `manifest.schema.ts` (a JSON Schema, compiled with Ajv) — the single source of truth for the manifest's fields and constraints. It is a presence-and-shape check that every field VIP consumes (identity, documentation, plugin runtime, the runtime-config schema, telemetry, and release metadata) is present and well-formed, not a check that the values are correct. `pnpm schema` writes the same schema to [`vip-manifest.schema.json`](vip-manifest.schema.json) in this folder, adding the 2020-12 `$schema`, and a test fails while that file is out of date. The Starter Kit ships a copy of it, so partners validate against the same contract in their editor.

Each `runtime_config` field can also carry validation rules, so the platform can check a saved value the way a hand-written integration checks it in its own code: `integer`, `min`, `max` and `unit` on numbers; `min_length`, `max_length`, `pattern` and `format` (`ip_or_cidr`, `url`, `email`) on the string-valued types; and a `list` type with `items` and `max_items`. Any field can set an `example`, used as the input placeholder, and `nullable`, whether saving `null` clears the value. The schema decides which key applies to which type with `if`/`then` rules, so `min` on a string fails instead of being ignored, and each rule's `$comment` is the message `validate` prints when it fails. `manifest.fields.ts` then checks what a JSON Schema can't: that `default` and `example` follow the field's own rules, that `min`/`max` and the length bounds are in order, and that a `pattern` compiles with the `v` flag browsers use for an input's `pattern` attribute. Those run once the schema passes, and fail the rule like a schema error.

Beyond the schema and the field checks, the same rule adds two more. First, it **fails** while any field still holds the `MANIFEST_PLACEHOLDER` sentinel that `init` leaves in the partner-only fields (contact, docs URLs), so a partner cannot submit a half-filled scaffold — this is the only one of the two that blocks conformance. Second, it cross-checks the config keys the plugin declares (`Config::REQUIRED_FIELDS` / `SENSITIVE_FIELDS`) against the manifest's `runtime_config.fields` and **warns** (does not fail) when a field is missing from or mis-typed in the manifest. That cross-check is best-effort — the plugin's contract is read heuristically from the PHP source, so it can't be certain it matched the real `Config` class, which is exactly why a mismatch is a non-blocking prompt to verify rather than a hard failure. It is skipped for any plugin that declares neither array.

## The scaffolder (`lib/scaffold`)

It derives a prefix set (pascal / kebab / snake / upper forms) from the vendor and integration names and rewrites the example tokens (`ExampleVendor`, `example-integration`, `VIP_EXAMPLE_INTEGRATION`, ...) across the tree. Replacement uses PHP `strtr` semantics — longest match wins and a replacement is never re-scanned.

## Dependencies

Runtime: [`commander`](https://github.com/tj/commander.js) for argument parsing, [`js-yaml`](https://github.com/nodeca/js-yaml) to parse the handoff manifest, and [`ajv`](https://ajv.js.org/) to validate it against the manifest JSON Schema. Colors are a ~20-line ANSI helper rather than a dependency, which keeps the build a plain CommonJS `tsc` compile with no ESM-only packages. Dev: `typescript`, `jest`, and `ts-jest` for the build and tests, plus `eslint` with [`@automattic/eslint-plugin-wpvip`](https://github.com/Automattic/eslint-plugin-wpvip) and `wp-prettier` for lint/format — the same tooling as [Automattic/commands](https://github.com/Automattic/commands). The package manager is **pnpm** (pinned via `packageManager`).
