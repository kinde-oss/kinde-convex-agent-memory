# Kinde Convex Agent Memory

The Kinde agent memory component for [Convex](https://convex.dev) — a tenant-isolated, governed memory layer for AI agents. It stores agent memory as structured records with vector embeddings for semantic recall, and enforces a server-verified tenant boundary, immutable provenance, policy-based redaction on read, and reactive revocation on every operation, all through one governed access path: no read — by key, by filter, or by vector search — can return a memory belonging to another tenant, enforced at the query rather than as a post-filter. Honest limitation: that guarantee covers access **through the component's API only** — it cannot govern data your app stores outside the component, or reads made with your deployment's admin credentials.

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://makeapullrequest.com) [![Kinde Docs](https://img.shields.io/badge/Kinde-Docs-eee?style=flat-square)](https://kinde.com/docs/developer-tools) [![Kinde Community](https://img.shields.io/badge/Kinde-Community-eee?style=flat-square)](https://thekindecommunity.slack.com)

## Development

This package is a Convex component plus a thin client. Day-to-day development:

- `npm install`: install the dependencies.
- `npm run build:codegen`: regenerate the component code and build it.
- `npm test`: run the full `convex-test` + `vitest` suite (with type-checking).
- `npm run typecheck`: type-check the package and the example app.
- `npm run lint`: run ESLint.
- `npm run format`: run Prettier over the repo.

The `example/` directory is a minimal Convex app that installs the component via `app.use`; the full reference app arrives with the example-app phase.

### Initial set up

1. Clone the repository to your machine:

   ```bash
   git clone https://github.com/kinde-oss/kinde-convex-agent-memory.git
   ```

2. Go into the project:

   ```bash
   cd kinde-convex-agent-memory
   ```

3. Install the dependencies:

   ```bash
   npm install
   ```

4. Regenerate the component code and build:

   ```bash
   npm run build:codegen
   ```

5. Run the tests:

   ```bash
   npm test
   ```

## Usage

_To come — the governed memory surface lands phase by phase; this section is filled in as it does._

### Install and wire up

_To come._

### Writing and recalling memory

_To come._

### Redaction and provenance

_To come._

### Reactive revocation

_To come._

### The `verifyCaller` seam

_To come — optional, app-supplied; the component is fully standalone without it._

### The `embedder` seam

_To come — optional, injectable; no embedding provider is hardcoded._

### Composes with auth, billing & tools

`@kinde-oss/kinde-convex-agent-memory` is a sibling of [`@kinde-oss/kinde-convex-agent-auth`](https://github.com/kinde-oss/kinde-convex-agent-auth), [`@kinde-oss/kinde-convex-agent-billing`](https://github.com/kinde-oss/kinde-convex-agent-billing), and [`@kinde-oss/kinde-convex-agent-tools`](https://github.com/kinde-oss/kinde-convex-agent-tools) in the Kinde AgentKit. They compose at the app level only — this component imports none of them.

## Documentation

For details, see the [Kinde docs](https://kinde.com/docs/), the [developer tools](https://kinde.com/docs/developer-tools/) section, and the [Convex components docs](https://docs.convex.dev/components).

## Publishing

The Kinde core team handles publishing.

## Contributing

Please refer to Kinde's [contributing guidelines](https://github.com/kinde-oss/.github/blob/489e2ca9c3307c2b2e098a885e22f2239116394a/CONTRIBUTING.md), [security policy](https://github.com/kinde-oss/.github/blob/main/SECURITY.md), and [code of conduct](https://github.com/kinde-oss/.github/blob/main/CODE_OF_CONDUCT.md).

## License

By contributing to Kinde, you agree that your contributions will be licensed under its MIT License.
