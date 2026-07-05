<!-- Ideally, this should get auto-generated via tools like [auto-changelog](https://github.com/CookPete/auto-changelog). Eventually, this will get set up as part of the repository template. -->

This project follows [Semantic Versioning](https://semver.org/).

## 0.1.0

Initial scaffold of the Kinde agent memory Convex component (P0 — no behavior yet).

- **Component skeleton** — `src/component/` with the component definition (`convex.config.ts`), an empty-but-valid schema, and generated code via Convex codegen.
- **Client skeleton** — `src/client/` with the `AgentMemory` class and the `MemoryComponentConfig` type: an optional `verifyCaller` slot (matching `@kinde-oss/kinde-convex-agent-auth`'s `verifyCaller` shape), an optional injectable `embedder` slot, and an optional `signingSecretEnvVar`. Types only; the component is fully standalone with none of them set.
- **Test harness** — `convex-test` + `vitest` wired with a `register(t, name)` export for consumers and a passing smoke test that mounts the component in the example app.
- **Example app** — a minimal Convex app installing the component via `app.use`; the full reference app arrives in a later phase.
- **Tooling** — strict TypeScript configs (root, build, test, example), ESLint flat config with the Convex plugin, and Prettier, consistent with the sibling AgentKit repos.
