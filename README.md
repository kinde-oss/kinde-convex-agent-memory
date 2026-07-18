# Kinde Convex Agent Memory

The Kinde agent memory component for [Convex](https://convex.dev). It gives an AI agent a place to store and recall memory that stays inside a tenant boundary you cannot accidentally omit. Every read and write carries a server-verified tenant context (`orgCode`), and that context is applied at the query, as the leading field of the index range, never as a post-filter you might forget. No read, whether by key, by filter, or by vector search, can return a memory that belongs to another tenant.

The value here is multi-tenant. If your app serves a single tenant, a where-clause on your own table does the same job and this component is overkill. Its reason to exist is the boundary that has to hold across many tenants sharing one Convex deployment, enforced by the component rather than by each query you remember to write.

The honest limitation, stated up front and not buried. The guarantee covers memory that is stored in and accessed through this component. Memory that a framework keeps in its own store and reads directly, and any code that reaches the tables with your deployment's admin or CLI credentials, is outside this boundary, and the component cannot govern it. What it does guarantee is strong and specific: memory stored in and accessed through this component is tenant-isolated, audited, redactable, and revocable.

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://makeapullrequest.com) [![Kinde Docs](https://img.shields.io/badge/Kinde-Docs-eee?style=flat-square)](https://kinde.com/docs/developer-tools) [![Kinde Community](https://img.shields.io/badge/Kinde-Community-eee?style=flat-square)](https://thekindecommunity.slack.com)

## Development

This package is a Convex component plus a thin client. The commands you need day to day:

- `npm install`: install the dependencies.
- `npm run build`: compile the package to `dist/`.
- `npm run build:codegen`: regenerate the component code and build it.
- `npm test`: run the full `convex-test` and `vitest` suite with type-checking.
- `npm run typecheck`: type-check the package and the example app.
- `npm run lint`: run ESLint.
- `npm run format`: run Prettier over the repo.

**Build before you test on a fresh clone.** The example app imports the component as a package (`@kinde-oss/kinde-convex-agent-memory`), which resolves to the built output in `dist/`. With no `dist/`, `npm test` fails in `example/convex/` because the package cannot be resolved. Run `npm run build` (or `npm run build:codegen`, which does both) first. Two things make this easy to misdiagnose: **`npm run typecheck` passes cleanly with no `dist/`** — it reads source, not the built package — so a green typecheck next to a red test suite is expected here and is not a contradiction; and only the example-app suites fail (`e2e.test.ts`, `http.test.ts`, the adapter suites), while the component's own tests pass because they import from source. A partial failure confined to `example/` is the signature. The same applies to a _stale_ `dist/`: tests then run against old code, so if a failure looks impossible — a symbol that exists but is "missing", an argument you just added being rejected — rebuild before debugging further.

The `example/` directory is a Convex app that installs the component via `app.use` and drives it end to end. Its `convex/e2e.test.ts` is a single two-tenant narrative that exercises every layer through the composed path. See `example/README.md` for what that story covers.

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

### Security model

Read this before exposing any of this component to the network. Its functions are raw machinery with **no authentication of their own** — the host app is the security boundary. This component decides which tenant's memory a caller may read and write, so an unwrapped function is not merely an information leak, it is a tenant-isolation bypass.

1. **Component functions are not authenticated.** A Convex component cannot see the host app's auth context (`ctx.auth`), so every mutation and query here is callable by whatever surface the host app exposes. Nothing in the component checks _who_ is calling or _which tenant they belong to_; that is the app's job. **`subject` and `orgCode` on every component-facing call MUST come from server-verified auth** — agent-auth's `verifyCaller`/`authorize` — **never from a client argument, a request body, or a header.** The boundary is keyed on `orgCode`: take it from request input and a caller names any tenant's memory as its own. `subject` is likewise the write-ownership and grant decision (points 4 and 8), so it too must be the verified value.

2. **Admin-only functions — never expose these publicly.** Wrap each in an app-layer function that authenticates a human or admin first. Everything that writes authority, or reads across the whole tenant, is admin-only:

   | Client method (component function) | Why it is admin-only |
   | --- | --- |
   | `grant` (`grants.grant`) | **Widens.** Creates the grant row that allows a subject a scope, and whose first appearance flips that subject from permissive to enforced (point 4). |
   | `revokeGrant` (`grants.revokeGrant`) | Deletes a grant. Attenuating, but a caller who can delete grants can lock any subject out. |
   | `setRedaction` (`policy.setRedaction`) | Sets or clears what reads redact — it controls what content leaves the component. |
   | `revoke` (`revocations.revoke`) | The kill switch. Denies reactively; `kind: 'global'`/`'org'` reach beyond one subject (point 3). |
   | `liftRevocation` (`revocations.liftRevocation`) | **Widens.** Undoes a revocation — the only call that restores a revoked caller. |
   | `auditQuery` (`audit.query`) | **Tenant-wide read.** Every filter is optional, so an unfiltered call enumerates every subject's decision history in the tenant. |
   | `provenanceOf` (`provenance.of`) | **Tenant-wide read.** Traces ANY record in the tenant by id. |

   `auditQuery` and `provenanceOf` are **admin reporting surfaces, not governed operations**: each takes a server-verified `orgCode` and enumerates the whole tenant, with **no per-subject scope gate at the component level, by design** (the host app is the trust boundary). Treat them as admin-only, and bind their `orgCode` to the caller's verified tenant — never a client-supplied one. `inspectRevocation` (`revocations.inspect`) is the same shape (it additionally surfaces a revocation `reason`); hold it to the same standard.

3. **The global kill switch is cross-tenant — gate it behind a dedicated admin role.** `revoke({kind: 'global'})` denies every caller in every tenant until lifted, and `{kind: 'org'}` denies a whole tenant. These are not per-subject controls, and an open surface here is a deployment-wide denial of service. Put them behind a distinct, higher-privileged role than ordinary per-subject administration. **The revocation admin path deliberately bypasses the revocation overlay:** `revoke`, `liftRevocation`, and the grant/redaction admin ops are tenant-gated but NOT revocation-gated — because an administrator must be able to lift a revocation that governs the very tenant they administer. If the overlay applied to them, a global or org revocation would be unliftable (the lift call would itself be denied `revoked`). That is intended, and it is exactly why these functions must be admin-only at the app layer: the component cannot self-defend here.

4. **Grants are permissive until the first grant row — the opposite of agent-tools.** A subject with no grant rows is **permissive**: it behaves as if grants did not exist, and can read and write freely. Its **first** grant row flips it to **enforced**, and from then on it holds exactly the scopes granted (`memory.read`, `memory.write`, `memory.recall`). This is the reverse of [`@kinde-oss/kinde-convex-agent-tools`](https://github.com/kinde-oss/kinde-convex-agent-tools), which is **deny-by-default** (a call with no matching grant is denied `no_grant`). The difference is deliberate — memory is usable standalone with zero configuration — but it means **an unconfigured subject is not restricted.** If you want enforcement, seed the grants: call `grant` for `memory.read`/`memory.write`/`memory.recall` as a subject is provisioned, so its first grant row lands before its first operation. Until then, do not read the absence of a denial as an authorization decision.

5. **Denial-audit durability: prefer actions, or catch the throw.** On a governed denial the client throws a typed `ConvexError` **after** the component has committed the denial's audit row. From an app **action**, the component mutation commits first, so the denial audit row is durable even as the throw propagates. From an app **mutation** that lets the throw propagate, Convex rolls back the whole transaction — **the denial audit row included.** Call governed methods from an action, or catch the `ConvexError` inside the mutation, whenever the denial must be recorded:

   ```ts
   import {ConvexError} from 'convex/values';

   // Durable: the component mutation commits before the action sees the throw.
   export const remember = action({
     handler: async (ctx, args) => {
       // subject/orgCode are the server-verified values resolved upstream.
       return await agentMemory.write(ctx, args);
     }
   });

   // In a mutation, CATCH the throw so the denial audit row is not rolled back.
   export const rememberInMutation = mutation({
     handler: async (ctx, args) => {
       try {
         return await agentMemory.write(ctx, args);
       } catch (err) {
         if (err instanceof ConvexError) return {denied: err.data};
         throw err;
       }
     }
   });
   ```

6. **The example is the model: internal-only drivers behind a public HTTP seam.** In `example/convex/example.ts` every driver is an `internalMutation`/`internalQuery`/`internalAction`, never public — each trusts a caller-supplied `subject`/`orgCode`, so exposing one publicly would let a client name any tenant. The one public surface is the HTTP seam in `example/convex/http.ts`, whose handlers resolve the tenant from a verified bearer token **before** touching the component. Hold your own app to that shape.

   **Production checklist:**
   - [ ] No component-facing surface takes `subject` or `orgCode` from client input — every one derives them from `verifyCaller`/`authorize` (point 1).
   - [ ] Every function in the point-2 table is behind an authenticated admin/human wrapper.
   - [ ] `revoke({kind: 'global' | 'org'})` sits behind a dedicated, higher-privileged admin role (point 3).
   - [ ] `auditQuery`/`provenanceOf`/`inspectRevocation` wrappers bind `orgCode` to the caller's verified tenant.
   - [ ] Grants are seeded for any subject you intend to enforce, before its first operation (point 4).
   - [ ] Governed calls that must audit their denials run from an action, or catch the `ConvexError` (point 5).
   - [ ] `MEMORY_SIGNING_SECRET` is both `convex env set` **and** bound into the component at `app.use` (point 7).

7. **`MEMORY_SIGNING_SECRET` must be BOTH set and bound.** The component reads it to key its audit digests (HMAC-SHA256 rather than plain SHA-256 — see [Install and wire up](#install-and-wire-up)). Convex isolates component env, so `npx convex env set` alone gives the value to your app but **not** to the component, which then silently takes the unkeyed fallback; you must also bind it into the component by reference at `app.use`. Both steps are required together. `example/convex/signingSecretBinding.test.ts` is a source-text guard that fails if the component stops declaring the env var, or if the app stops declaring or binding it — the in-memory test harness shares one process env across app and component, so it cannot otherwise distinguish the secret arriving through the real binding from it merely being present globally, and a dropped binding would pass unnoticed without this guard.

8. **Write ownership and provenance redaction.** A `(orgCode, key)` record is owned by the subject that created it. A write by a **different** subject is denied `key_owned_by_other_subject`, never a silent overwrite — grants are per-subject and the record carries its subject as provenance, so a cross-subject overwrite would contradict both. Same-subject re-writes and brand-new keys are unaffected. Separately, `provenanceOf`'s identity strings (`key`, `subject`, and the actor stamps that equal that subject) run through the **same redaction policy egress uses**: with a policy in force for the record's `(org, subject)` they come back redacted, so a sensitive key path or subject id does not leak through the reporting surface; with no policy they are unchanged. `memoryId` and timestamps are always raw.

### Install and wire up

Install the component into your Convex app's config and mount it:

```ts
// convex/convex.config.ts
import {defineApp} from 'convex/server';
import {v} from 'convex/values';
import memory from '@kinde-oss/kinde-convex-agent-memory/convex.config.js';

// Declare the signing secret on the app and bind it into the component. Convex
// isolates component env, so a deployment-wide env var does not reach the
// component unless you thread it in here (see MEMORY_SIGNING_SECRET below). Omit
// the env entirely if you are running the unkeyed fallback.
const app = defineApp({
  env: {MEMORY_SIGNING_SECRET: v.optional(v.string())}
});
app.use(memory, {
  env: {MEMORY_SIGNING_SECRET: app.env.MEMORY_SIGNING_SECRET}
});
export default app;
```

Construct the client once with the component reference from your generated `components` object. Both config slots are optional and the component is fully standalone with neither set:

```ts
// convex/agentMemory.ts
import {AgentMemory} from '@kinde-oss/kinde-convex-agent-memory';
import {components} from './_generated/api';

export const agentMemory = new AgentMemory(components.memory, {
  // Optional. Enables recall by query text. No provider is hardcoded; you
  // supply whichever embedding model you use.
  embedder: async (text) => embedModel(text),
  // Optional. Verifies HTTP callers and resolves their tenant. Only the
  // direct-HTTP handlers use it (see The HTTP seam).
  verifyCaller
});
```

`MEMORY_SIGNING_SECRET` is an optional secret the component reads to key its audit digests. When the component sees it, the digests in the audit trail are HMAC-SHA256 keyed by it. When it does not, they are plain SHA-256. The honest tradeoff: an unkeyed digest of a low-entropy value, such as a short memory key or a subject id, can be enumerated by anyone who can read the audit rows, because they can hash a dictionary of candidates and match. The secret defeats that.

Two steps are required, and the first alone is not enough. Set the value out of band, never in code:

```bash
npx convex env set MEMORY_SIGNING_SECRET "$(openssl rand -hex 32)"
```

Then bind it into the component at `app.use`, as the wire-up above shows. This second step is required: Convex isolates component env, so `convex env set` alone gives the value to your app's functions but not to the component, and the component silently takes the unkeyed fallback. The binding (`env: {MEMORY_SIGNING_SECRET: app.env.MEMORY_SIGNING_SECRET}`) threads the deployment env var into the component by reference, resolved at runtime, so nothing is hardcoded. With both steps done the component runs keyed; with neither it runs the documented unkeyed fallback.

In every call below, `orgCode` is the server-verified tenant your app resolved from its own auth, not request input. The `subject` is the principal the operation acts for.

### Writing and recalling memory

`write` stores a tenant-stamped record. Supply an `embedding` alongside the content if you want the record to be recallable; the component never embeds on write. A `(orgCode, key)` record is owned by the subject that created it: the owning subject's re-writes update it in place, but a write to a key owned by a **different** subject is denied `key_owned_by_other_subject`, never a silent overwrite (see [Security model](#security-model), point 8).

```ts
import {mutation, action} from './_generated/server';
import {v} from 'convex/values';
import {agentMemory} from './agentMemory';

export const remember = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    key: v.string(),
    content: v.string()
  },
  handler: async (ctx, args) => {
    const result = await agentMemory.write(ctx, {
      ...args,
      embedding: await embed(args.content)
    });
    return result.memoryId;
  }
});
```

`recall` runs a tenant-partitioned vector search and returns matches ordered by score. It is an action, because vector search exists only in Convex actions. Pass a ready `embedding`, or pass `query` text and let the configured embedder turn it into a vector:

```ts
export const search = action({
  args: {subject: v.string(), orgCode: v.string(), query: v.string()},
  handler: async (ctx, args) => {
    const {matches} = await agentMemory.recall(ctx, {...args, topK: 8});
    return matches.map((m) => ({key: m.memory.key, score: m.score}));
  }
});
```

`get` reads one record by key, and returns null when no record with that key exists in this tenant. A key held by another tenant is indistinguishable from a missing one. `list` pages over the tenant's memories with a closed, plain-data filter:

```ts
const record = await agentMemory.get(ctx, {subject, orgCode, key});

const page = await agentMemory.list(ctx, {
  subject,
  orgCode,
  filter: {keyPrefix: 'notes/'},
  paginationOpts: {numItems: 50, cursor: null}
});
// Walk page.continueCursor until page.isDone.
```

### Grants and redaction

A subject with no grant rows is permissive and behaves as if grants did not exist. Its first grant flips it to enforced mode, and from then on it holds exactly the scopes granted. The scopes are `memory.read`, `memory.write`, and `memory.recall`.

```ts
await agentMemory.grant(ctx, {
  subject: adminSubject,
  orgCode,
  targetSubject: agentSubject,
  scope: 'memory.read'
});
await agentMemory.revokeGrant(ctx, {
  subject: adminSubject,
  orgCode,
  targetSubject: agentSubject,
  scope: 'memory.read'
});
```

`setRedaction` sets a policy that shapes what reads return. It never alters the stored row. `fields` holds metadata field names and the literal `content`. Redacted metadata is omitted on read and redacted content comes back as the `CONTENT_REDACTED` sentinel. An empty `fields` array clears the policy.

```ts
await agentMemory.setRedaction(ctx, {
  subject: adminSubject,
  orgCode,
  targetSubject: agentSubject, // omit for an org-wide policy
  fields: ['content', 'email']
});
```

### Reactive revocation

Revocation is a kill switch that outranks grants. A revoked caller is denied `revoked` no matter what scopes it holds, and a fresh grant cannot bring it back. Only lifting the revocation does. Targets are `global`, `org`, or `subject`. The `reason` is stored on the revocation row and never enters an audit row or a denial message.

```ts
await agentMemory.revoke(ctx, {
  subject: adminSubject,
  orgCode,
  target: {kind: 'subject', orgCode, subject: agentSubject},
  reason: 'bearer token compromised'
});
await agentMemory.liftRevocation(ctx, {
  subject: adminSubject,
  orgCode,
  target: {kind: 'subject', orgCode, subject: agentSubject}
});
```

### Audit, provenance, and the reason join

These three are read-only queries. They throw a typed error on an argument problem rather than returning a denial, because a query writes no audit row of its own.

```ts
// Paginated, tenant-scoped, newest first.
const trail = await agentMemory.auditQuery(ctx, {
  orgCode,
  filter: {operation: 'recall'},
  paginationOpts: {numItems: 50, cursor: null}
});

// A record's immutable creation event and its latest write event. No content.
// This is a tenant-wide admin reporting surface: a verified orgCode traces any
// record in the tenant, with no per-subject scope gate (wrap it admin-only).
// Its identity strings (key, subject, actor stamps) are redacted when a
// redaction policy applies to the record's (org, subject); ids/timestamps stay raw.
const provenance = await agentMemory.provenanceOf(ctx, {orgCode, memoryId});

// The revocation rows for a target, including the reason, plus the target
// digest. This is how you answer "why was this denied" from a 'revoked' audit
// row without the reason ever sitting in the log.
const inspection = await agentMemory.inspectRevocation(ctx, {
  orgCode,
  target: {kind: 'subject', orgCode, subject: agentSubject}
});
```

### The `verifyCaller` seam

For direct HTTP callers, the component needs a way to verify who is calling and resolve the tenant from the verified token, never from the request body. That is the `verifyCaller` slot. Its shape is deliberately minimal — a bare token in, a verified caller out:

```ts
type VerifyCaller = (token: string) => Promise<VerifiedCaller>;

interface VerifiedCaller {
  subject: string; // the principal the operation acts for
  orgCode: string | null; // the server-verified tenant memory binds to
  // agentId, scopes, claims are also carried; only subject and orgCode are consumed.
}
```

The HTTP handlers require a **non-empty `orgCode`** and reject a caller without one — memory is tenant-keyed, so an org-less caller cannot name a tenant. A `verifyCaller` that throws is treated as a rejected token (401).

The component imports no auth package; you compose one at the app level. With [`@kinde-oss/kinde-convex-agent-auth`](https://github.com/kinde-oss/kinde-convex-agent-auth) this is **not a one-liner** — auth's `verifyCaller` is `ctx`-dependent (it consults the JWKS cache, the agent registry, and the revocation overlay), so it cannot be dropped straight into `new AgentMemory(component, {verifyCaller})` at module scope. See [Composing with kinde-convex-agent-auth](#composing-with-kinde-convex-agent-auth) for the adapter closure. The example app ships a fake `verifyCaller` that maps a few test tokens to tenants — a stand-in for a real one.

The token's `scopes` describe the token. They do not become the component's grant scopes. Grants are the component's own authority. If you want a token scope to imply a grant, call `grant` for it explicitly.

### The `embedder` seam

The `embedder` slot is an app-supplied function from text to a vector. No embedding provider is hardcoded. Without an embedder the component is still fully usable: structured memory works end to end, and only recall by query text is unavailable, since you can still pass a ready `embedding` to `recall`.

### The HTTP seam

`agentMemory.httpHandlers()` returns handlers you mount on your app's own router. Component HTTP actions cannot read the app's env or auth, so the handlers live in the client and the app mounts them, passing `verifyCaller` in through the client config.

```ts
// convex/http.ts
import {httpRouter} from 'convex/server';
import {httpAction} from './_generated/server';
import {agentMemory} from './agentMemory';

const handlers = agentMemory.httpHandlers();
const http = httpRouter();
http.route({
  path: '/memory/write',
  method: 'POST',
  handler: httpAction(handlers.write)
});
http.route({
  path: '/memory/get',
  method: 'POST',
  handler: httpAction(handlers.get)
});
http.route({
  path: '/memory/list',
  method: 'POST',
  handler: httpAction(handlers.list)
});
http.route({
  path: '/memory/recall',
  method: 'POST',
  handler: httpAction(handlers.recall)
});
export default http;
```

`httpHandlers()` requires `verifyCaller`, and throws `verify_caller_not_configured` at mount time if it is missing. Each request authenticates the bearer token, takes `subject` and `orgCode` from the verified caller, and reads only the operation payload from the JSON body. A body that names its own `orgCode` is treated as a claimed tenant and rejected with `tenant_context_conflict` if it differs from the verified one. Seam-level rejections, such as a missing or bad token or a malformed body, happen before any governed call and write no audit row. Once a governed operation runs, it audits exactly once, denials included.

### Capability reference

Per operation, the governance that applies. The governed memory operations run the full pipeline in order: tenant-conflict check, then revocation overlay, then scope gate, then the operation. The administration operations are tenant-gated and audited but not scope-gated and not revocation-gated, because an administrator has to be able to lift a revocation even for a revoked tenant. The reporting queries are tenant-scoped and read-only and write no audit row.

| Operation | Tenant isolation | Scope gate | Redaction on read | Revocation gate | Writes audit row |
| --- | --- | --- | --- | --- | --- |
| `write` | yes | `memory.write` | n/a | yes | yes |
| `get` | yes | `memory.read` | yes | yes | yes |
| `list` | yes | `memory.read` | yes | yes | yes |
| `recall` | yes, partitioned | `memory.recall` | yes | yes | yes |
| `grant`, `revokeGrant` | yes | no, app-trusted | n/a | no | yes |
| `setRedaction` | yes | no, app-trusted | n/a | no | yes |
| `revoke`, `liftRevocation` | yes | no, app-trusted | n/a | no | yes |
| `auditQuery` | yes, at the index | no | n/a, holds no content | no | no |
| `provenanceOf` | yes | no | yes, identity fields | no | no |
| `inspectRevocation` | yes | no | n/a | no | no |

### Two caveats worth reading

The audit row's `keyOrQueryDigest` column has two meanings. For a normal operation it is a digest of the operation's key, filter, or target. For a denial whose `reasonCode` is `revoked`, it is instead the revocation target digest. That is deliberate: it is what lets you join a `revoked` denial to `inspectRevocation` and read the reason, while the reason itself never sits in the append-only log. If you read raw audit rows, know that this column changes meaning on a `revoked` row.

The framework adapters in the example are example-only, all five of them. The example ships governed adapters for five frameworks in two shapes. For a framework that exposes a vector-store interface the adapter is a governed store subclass: `GovernedConvexVector` for Mastra (`example/convex/mastraAdapter.ts`), `GovernedLangChainVectorStore` for LangChain (`langchainAdapter.ts`), and `GovernedLlamaIndexVectorStore` for LlamaIndex (`llamaindexAdapter.ts`). For a framework whose memory is tool-based the adapter is a pair of governed tools, a save tool and a search tool: one pair for the Vercel AI SDK (`vercelAdapter.ts`) and one for the OpenAI Agents SDK (`openaiAgentsAdapter.ts`). Every adapter is bound to a server-verified tenant at construction and routes every call through this component's client, so tenant isolation, audit, redaction, and revocation are inherited rather than re-added. Each one contrasts with the framework's own access, which reaches the store with an admin or deployment key, or scopes memory only by a `user_id` argument the caller passes and can get wrong, and so cannot be governed per call. In the tool adapters the tenant is not even a tool parameter; it is closed over at construction, so no argument the model produces can name or change it. The shipped package depends on no framework package. These prove the governed pattern is framework-agnostic. They are demonstrations, not shipped integrations, and wiring one into your own app is your step.

### Composes with auth, billing, and tools

`@kinde-oss/kinde-convex-agent-memory` is a sibling of the other Kinde AgentKit components. Composition is app-level in every case, and this component imports none of them.

[`@kinde-oss/kinde-convex-agent-auth`](https://github.com/kinde-oss/kinde-convex-agent-auth) verifies agent tokens and resolves the tenant. Its `verifyCaller` is the source of the server-verified `subject` and `orgCode` every memory call needs; because that function is `ctx`-dependent, you adapt it with a small closure rather than passing it straight in — see [Composing with kinde-convex-agent-auth](#composing-with-kinde-convex-agent-auth).

[`@kinde-oss/kinde-convex-agent-billing`](https://github.com/kinde-oss/kinde-convex-agent-billing) meters and bills agent activity. You call it from the same app functions that call memory, using the same verified tenant, so usage is attributed to the tenant that incurred it.

[`@kinde-oss/kinde-convex-agent-tools`](https://github.com/kinde-oss/kinde-convex-agent-tools) governs the tools an agent may call. It runs alongside memory in your app functions, with the same verified `subject` and `orgCode`, so a tool call and the memory it reads or writes share one tenant context.

### Composing with kinde-convex-agent-auth

[`@kinde-oss/kinde-convex-agent-auth`](https://github.com/kinde-oss/kinde-convex-agent-auth) answers _who is calling and which tenant they belong to_; this component answers _may that identity read or write this tenant's memory_. They pair at the app level through `subject` and `orgCode`, and neither imports the other.

The wiring rule is the whole integration: **verify first, then call memory with the identity the verification returned.** The catch is that auth's `verifyCaller` is `ctx`-dependent — its signature is `verifyCaller(ctx, component, token, options?) => Promise<VerifiedAgent>`, because it consults the JWKS cache, the agent registry, and the revocation overlay — whereas memory's HTTP seam wants a `(token) => Promise<VerifiedCaller>`. So you build a small adapter **where `ctx` is in scope**. (A `VerifiedAgent` is field-for-field a memory `VerifiedCaller`, so the mapping is an identity plus one explicit narrowing: an org-less token cannot name a tenant.)

**HTTP seam.** Build the adapter per request, inside the `httpAction`, and hand memory a client wired with it:

```ts
// convex/http.ts
import {httpRouter} from 'convex/server';
import {httpAction} from './_generated/server';
import {AgentMemory} from '@kinde-oss/kinde-convex-agent-memory';
import type {VerifyCaller} from '@kinde-oss/kinde-convex-agent-memory';
import {verifyCaller} from '@kinde-oss/kinde-convex-agent-auth';
import {components} from './_generated/api';

const http = httpRouter();

// One route = verify the caller with agent-auth, then drive one memory handler.
// The adapter is built HERE, per request, because auth's verifyCaller needs ctx.
function memoryRoute(op: 'write' | 'get' | 'list' | 'recall') {
  return httpAction(async (ctx, request) => {
    const verify: VerifyCaller = async (token) => {
      const caller = await verifyCaller(ctx, components.agentAuth, token);
      // Handle the org-less case explicitly: memory is tenant-keyed, so a token
      // with no org_code cannot name a tenant. Throwing is a clean 401.
      if (caller.orgCode === null) {
        throw new Error('token carries no org_code; memory requires a tenant');
      }
      return caller; // {subject, orgCode, agentId, scopes, claims}
    };
    const handlers = new AgentMemory(components.memory, {
      verifyCaller: verify
      // add `embedder` here too if you want the recall route to accept query text
    }).httpHandlers();
    return handlers[op](ctx, request);
  });
}

http.route({path: '/memory/write', method: 'POST', handler: memoryRoute('write')});
http.route({path: '/memory/get', method: 'POST', handler: memoryRoute('get')});
http.route({path: '/memory/list', method: 'POST', handler: memoryRoute('list')});
http.route({path: '/memory/recall', method: 'POST', handler: memoryRoute('recall')});

export default http;
```

`AgentMemory` is a thin client (a component reference plus options), so constructing one per request is cheap. The body-supplied `orgCode`, if any, still rides as `claimedOrgCode` and is rejected on mismatch — the token, not the body, is the tenant.

**Convex-facing (non-HTTP).** When you already hold a token inside an action, skip the HTTP seam: verify first, then call memory directly with the derived `{subject, orgCode}`. `verifyCaller` runs in an **action** (it may refresh the JWKS via `ctx.runAction`), so this pattern is an action, not a mutation:

```ts
import {action} from './_generated/server';
import {v} from 'convex/values';
import {verifyCaller} from '@kinde-oss/kinde-convex-agent-auth';
import {components} from './_generated/api';
import {agentMemory} from './agentMemory'; // the module-scope client

export const remember = action({
  args: {token: v.string(), key: v.string(), content: v.string()},
  handler: async (ctx, args) => {
    const caller = await verifyCaller(ctx, components.agentAuth, args.token);
    if (caller.orgCode === null) {
      throw new Error('token carries no org_code; memory requires a tenant');
    }
    return await agentMemory.write(ctx, {
      subject: caller.subject,
      orgCode: caller.orgCode, // server-verified tenant, from the token
      key: args.key,
      content: args.content
    });
  }
});
```

In both patterns the `orgCode` reaching memory is the one auth verified from the token, never request input — which is exactly what the [Security model](#security-model) requires.

### What the tests prove, and what a live pass has still to check

The test suite runs in `convex-test`, an in-memory harness, not against a live Convex deployment. It proves the governance logic and the tenant isolation invariant under that harness, with a deterministic fake embedder and the harness's own vector search. It does not prove the same against a real deployment with a real embedding model. A live verification pass still has to exercise real-embedder two-tenant recall isolation two ways: through the raw client API, and through each of the five example adapters, the three store subclasses (Mastra, LangChain, LlamaIndex) and the two tool pairs (Vercel AI SDK, OpenAI Agents SDK). Until that pass runs, treat the adapters as demonstrated under test, not live-verified.

## Documentation

For details, see the [Kinde docs](https://kinde.com/docs/), the [developer tools](https://kinde.com/docs/developer-tools/) section, and the [Convex components docs](https://docs.convex.dev/components).

## Publishing

The Kinde core team handles publishing.

## Contributing

Please refer to Kinde's [contributing guidelines](https://github.com/kinde-oss/.github/blob/489e2ca9c3307c2b2e098a885e22f2239116394a/CONTRIBUTING.md), [security policy](https://github.com/kinde-oss/.github/blob/main/SECURITY.md), and [code of conduct](https://github.com/kinde-oss/.github/blob/main/CODE_OF_CONDUCT.md).

## License

By contributing to Kinde, you agree that your contributions will be licensed under its MIT License.
