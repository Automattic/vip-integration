# vip-integration

A CLI for building **WordPress VIP Integration Center** add-ons. It does two things:

- **`vip-integration init`** — scaffold a new integration from the [VIP Integrations Starter Kit](https://github.com/Automattic/vip-integrations-starter-kit), with the example prefix set already rewritten to your names.
- **`vip-integration validate`** — run the integration conformance checker locally and in CI, so you get an objective _conformant / not-conformant_ answer before you submit.

It is a standalone home for the checker that used to live in `vip-cli`, decoupled so the Integration Center can extend to other parts of Automattic (.com / a4a).

## Install

```bash
npm install -g @automattic/vip-integration
```

Or run without installing:

```bash
npx @automattic/vip-integration validate
```

Requires Node.js 20+ and git 2.18+ (`init` uses `git ls-remote --sort`).

## Usage

### Start a new integration

```bash
vip-integration init
```

Interactive — it asks for your **vendor name** and **integration name**, always builds from the canonical [VIP Integrations Starter Kit](https://github.com/Automattic/vip-integrations-starter-kit) (pinned to its newest release tag, no git history pulled), rewrites the example prefix set to your names, and renames the entry file. You can also pass the answers as flags:

```bash
vip-integration init --vendor "WordPress" --name "Content Sync"
```

For this example, `init` rewrites the Starter Kit's `exampleintegration_`
telemetry prefix to `contentsync_`; other snake-case code prefixes remain
`content_sync_`.

| Flag                | Description                                          |
| ------------------- | ---------------------------------------------------- |
| `--vendor <vendor>` | Vendor name, e.g. `"My Vendor"`.                     |
| `--name <name>`     | Integration name, e.g. `"Content Sync"`.             |
| `--dir <dir>`       | Target directory (defaults to the integration slug). |

The Starter Kit source is not configurable — `init` always uses the official VIP repo.

When it finishes:

```bash
cd content-sync
composer install && npm install
# edit your integration, then:
vip-integration validate
```

### Validate an integration

```bash
vip-integration validate               # checks the current directory
vip-integration validate ./my-plugin   # checks a given directory
vip-integration validate --format json # machine-readable output for CI
```

The checker runs nine static conformance rules and prints a per-rule report. It exits `1` when the integration is **not conformant** (any rule failed), so it gates CI. Warnings do not break conformance. Two items — the plugin/platform config-schema match and the security review — are surfaced as _human review required_ rather than automated pass/fail, because they cannot be checked statically.

Point your editor at the generated [manifest JSON Schema](docs/vip-manifest.schema.json) for the supported fields and validation rules in `vip-manifest.yaml`. Run `vip-integration validate` to check the manifest, including constraints an editor's schema validation cannot check; see the [conformance checker architecture](docs/architecture.md#the-conformance-checker-libvalidate).

## Documentation

- [Setup](docs/setup.md) — install, build, and run from source.
- [Architecture](docs/architecture.md) — how the CLI and the checker are put together.
- [Testing](docs/testing.md) — how to run and extend the test suite.
- [Releasing](docs/releasing.md) — how to cut and publish an npm release.
