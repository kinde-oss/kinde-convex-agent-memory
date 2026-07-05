<!-- Ideally, this should get auto-generated via tools like [auto-changelog](https://github.com/CookPete/auto-changelog). Eventually, this will get set up as part of the repository template. -->

This project follows [Semantic Versioning](https://semver.org/).

## 0.1.0

Initial release of the Kinde agent memory Convex component.

- **The governed access path** — every read and write of the `memories` table flows through one module (`access.ts`) that applies the server-verified tenant constraint (`orgCode`) at the query, as the leading field of a `by_org_*` index range — never as a post-filter (grep-verified by a structural test).
- **Governed write** — `memory.write` stores tenant-stamped records with two provenance stamps: an immutable creation event (`createdBy`/`createdAt`, never patched) and a latest-write event (`writtenBy`/`writtenAt`/`mandateId`, re-stamped on every update).
- **Governed read-by-key** — `memory.get` is constrained by `by_org_key` at the query; a key held by another tenant reads as null exactly as if it did not exist (no cross-tenant existence oracle).
- **Tenant context conflict** — an optional `claimedOrgCode` (anything that arrived from a client) that differs from the server-verified `orgCode` denies typed `tenant_context_conflict` before any memory access, and the denial is audited.
- **Tenant-scoped idempotency** — an `idempotencyKey` replays within its tenant (same id, no duplicate, first write wins) and is independent across tenants; reusing one for a different key denies typed `idempotency_key_reused`.
- **Audit from day one** — exactly one audit row per governed operation (reads, replays, and denials included), carrying a redacted key digest (never raw keys or content) and a correlation id that round-trips when supplied and is minted when absent.
- **Typed denials that keep their audit row** — component mutations return denials (a throw would roll the audit row back); the `AgentMemory` client converts them into thrown typed `ConvexError`s.

Earlier scaffold (P0 — structure only):

- **Component skeleton** — `src/component/` with the component definition (`convex.config.ts`), an empty-but-valid schema, and generated code via Convex codegen.
- **Client skeleton** — `src/client/` with the `AgentMemory` class and the `MemoryComponentConfig` type: an optional `verifyCaller` slot (matching `@kinde-oss/kinde-convex-agent-auth`'s `verifyCaller` shape), an optional injectable `embedder` slot, and an optional `signingSecretEnvVar`. Types only; the component is fully standalone with none of them set.
- **Test harness** — `convex-test` + `vitest` wired with a `register(t, name)` export for consumers and a passing smoke test that mounts the component in the example app.
- **Example app** — a minimal Convex app installing the component via `app.use`; the full reference app arrives in a later phase.
- **Tooling** — strict TypeScript configs (root, build, test, example), ESLint flat config with the Convex plugin, and Prettier, consistent with the sibling AgentKit repos.
