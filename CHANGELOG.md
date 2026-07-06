<!-- Ideally, this should get auto-generated via tools like [auto-changelog](https://github.com/CookPete/auto-changelog). Eventually, this will get set up as part of the repository template. -->

This project follows [Semantic Versioning](https://semver.org/).

## 0.1.0

The first release of the Kinde agent memory Convex component: a tenant-isolated, governed memory layer for AI agents. What it contains:

Governed storage and recall. Agents store memory as structured records with optional vector embeddings and recall it by key, by filter, or by semantic vector search. Every read and write carries a server-verified tenant context (`orgCode`) that is applied at the query as the leading field of the index range, never as a post-filter. Recall runs inside the tenant's partition of the vector index, so a better-matching row in another tenant is outside the searched set rather than filtered out of the results. One module owns all access to the memory table, which a structural test enforces by grep.

Provenance and idempotency. Each record keeps two provenance stamps: an immutable creation event that is never patched, and a latest-write event that re-stamps on every update. An idempotency key replays within its tenant and is independent across tenants; reusing one for a different key is a typed denial rather than a silent coercion.

Access control. Per-subject scope grants gate the memory operations. A subject with no grants is permissive; its first grant flips it to enforced, after which it holds exactly the scopes granted. A revocation overlay sits above grants as a kill switch at the global, org, or subject level: a revoked caller is denied regardless of the scopes it holds, and only lifting the revocation restores access. The revocation reason is stored on the revocation row alone and never enters the audit log.

Redaction on read. A per-tenant policy, optionally targeted at one subject, hides metadata fields or the record body from reads. It shapes the egress copy only and never alters the stored row.

Audit and reporting. Every governed operation writes exactly one audit row, reads and denials included, carrying a keyed digest rather than raw keys or content. Three read-only reporting queries expose the trail without themselves auditing: a paginated tenant-scoped audit query, a provenance lookup that returns identity and provenance stamps but no content, and a revocation inspection that returns the reason for a denial by joining on the revocation target digest that the denial's audit row carries.

The HTTP seam. The client provides HTTP handlers the app mounts on its own router. The tenant comes from a verified bearer token through an app-supplied `verifyCaller`, never from the request body; a body that names another tenant is rejected as a claimed-tenant conflict.

Composition, not coupling. The component imports no auth, billing, or framework package. Auth's `verifyCaller` and an embedding provider are optional slots the app supplies. `MEMORY_SIGNING_SECRET` optionally keys the audit digests. The repository includes an example Convex app with a two-tenant end-to-end narrative and five example-only framework adapters in two shapes, each routing through the governed client. For frameworks with a vector-store interface there are governed store subclasses for Mastra, LangChain, and LlamaIndex. For frameworks whose memory is tool-based there are governed save and search tool pairs for the Vercel AI SDK and the OpenAI Agents SDK, with the tenant closed over at construction rather than passed as a tool argument. Each adapter is bound to a server-verified tenant and inherits tenant isolation, audit, redaction, and revocation from the client; they demonstrate that the governed pattern is framework-agnostic rather than ship framework integrations.
