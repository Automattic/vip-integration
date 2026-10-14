# Testing

The suite is [Jest](https://jestjs.io/) with [ts-jest](https://kulshekhar.github.io/ts-jest/), so tests run straight against the TypeScript sources — no build step needed.

## Run the tests

```bash
pnpm test
```

Run a single file or match by name:

```bash
pnpm exec jest scaffold
pnpm exec jest -t "conformant"
```

## The manifest JSON Schema

`docs/vip-manifest.schema.json` is generated from `src/lib/validate/manifest.schema.ts`. After changing the schema, regenerate it:

```bash
pnpm schema
```

`__tests__/manifest.test.ts` fails until the committed file matches the source.

## Before you push

```bash
pnpm lint && pnpm format:check && pnpm check-types && pnpm test
```
