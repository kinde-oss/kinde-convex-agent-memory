# Example app

A Convex app that installs the memory component through `convex/convex.config.ts` and drives it end to end. It stands in for a real host app: it constructs the `AgentMemory` client once (`convex/example.ts`), supplies a fake embedder and a fake `verifyCaller`, exposes thin driver functions over the client, and mounts the client's HTTP handlers on its own router (`convex/http.ts`).

## Running it

The tests run in-process with `convex-test`, no deployment required. From the repo root:

```
npm test
```

Code generation runs without a Convex login via `CONVEX_AGENT_MODE=anonymous` (the test script sets what it needs).

## The two-tenant story

`convex/e2e.test.ts` is the reference narrative. It runs as one test that reads top to bottom, two tenants sharing a single component, with an assertion behind every beat. The agent-facing memory operations (write, get, recall) go through the HTTP handlers, where the tenant is resolved from a bearer token by `verifyCaller` and never read from the request body. The administrative operations (grants, redaction, revocation, and the audit and provenance reads) go through the client drivers, the way a host app would call them internally.

The fake `verifyCaller` in `convex/example.ts` maps a set of test tokens to tenants. In production this is `@kinde-oss/kinde-convex-agent-auth`'s `verifyCaller`, which validates a real JWT and returns the same shape. The component itself imports no auth package; the app composes auth at its edge.

What the story demonstrates, in order:

Tenancy comes from the token. Each write carries no org code in its body. The handler runs the token through `verifyCaller` and binds the governed write to the tenant that comes back.

Recall is partitioned. Org A and org B each write memories. B holds a row whose embedding is an exact match for A's query, a better answer than anything A wrote. A recalls and sees only A's rows; B's better match never appears. B runs the identical query and sees only B's. The partition is enforced by the vector index, which filters on the org code, not by anything the caller can set.

Redaction shapes egress, not storage. A sets a policy that hides a PII metadata field and the record body from its own agent's reads. The read comes back redacted; clearing the policy returns the full record, which proves the stored row was never altered. B, with no policy, is unaffected.

Grants gate by subject. A subject writes freely until its first grant, which flips it to enforced mode. From then on it holds exactly the scopes it was granted: an ungranted write is denied `scope_not_granted`, and granting the scope restores it. Other subjects are untouched.

Revocation is a kill switch that outranks grants. A's agent recalls successfully, is revoked, and the very next recall is denied `revoked` with the same credentials. Lifting the revocation restores it. The other tenant is not affected.

Provenance and audit close the loop. The provenance surface separates the immutable creation event from the latest write. The audit log reads newest first and holds the writes, recalls, and the revocation. A correlation id threaded through a write and a read stitches them together in the log. The `revoked` denial carries the revocation target digest, and `inspectRevocation` returns that same digest alongside the reason, so an auditor can follow the denial back to why it happened without the reason ever sitting in the append-only log.

## Other test files

`memory.test.ts`, `recall.test.ts`, and `governance.test.ts` cover the client methods in isolation. `http.test.ts` covers the HTTP seam, including the cases where the body tries to name another tenant. `mastra.test.ts` covers the example-only governed Mastra vector adapter (`convex/mastraAdapter.ts`), which routes a Mastra-shaped vector store through the same governed client so recall stays tenant-bound.
