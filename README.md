# Kinde Convex Agent Memory

The Kinde agent memory component for [Convex](https://convex.dev). It gives an AI agent a place to store and recall memory that stays inside a tenant boundary you cannot accidentally omit. Every read and write carries a server-verified tenant context (`orgCode`), and that context is applied at the query, as the leading field of the index range, never as a post-filter you might forget. No read, whether by key, by filter, or by vector search, can return a memory that belongs to another tenant.

The value here is multi-tenant. If your app serves a single tenant, a where-clause on your own table does the same job and this component is overkill. Its reason to exist is the boundary that has to hold across many tenants sharing one Convex deployment, enforced by the component rather than by each query you remember to write.

The honest limitation, stated up front and not buried. The guarantee covers memory that is stored in and accessed through this component. Memory that a framework keeps in its own store and reads directly, and any code that reaches the tables with your deployment's admin or CLI credentials, is outside this boundary, and the component cannot govern it. What it does guarantee is strong and specific: memory stored in and accessed through this component is tenant-isolated, audited, redactable, and revocable.

[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](https://makeapullrequest.com) [![Kinde Docs](https://img.shields.io/badge/Kinde-Docs-eee?style=flat-square)](https://kinde.com/docs/developer-tools) [![Kinde Community](https://img.shields.io/badge/Kinde-Community-eee?style=flat-square)](https://thekindecommunity.slack.com)

## Development

This package is a Convex component plus a thin client. The commands you need day to day:

- `npm install`: install the dependencies.
- `npm run build:codegen`: regenerate the component code and build it.
- `npm test`: run the full `convex-test` and `vitest` suite with type-checking.
- `npm run typecheck`: type-check the package and the example app.
- `npm run lint`: run ESLint.
- `npm run format`: run Prettier over the repo.

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

### Install and wire up

Install the component into your Convex app's config and mount it:

```ts
// convex/convex.config.ts
import {defineApp} from 'convex/server';
import memory from '@kinde-oss/kinde-convex-agent-memory/convex.config.js';

const app = defineApp();
app.use(memory);
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

`MEMORY_SIGNING_SECRET` is an optional environment variable the component reads to key its audit digests. When it is set, the digests in the audit trail are HMAC-SHA256 keyed by it. When it is not set, they are plain SHA-256. The honest tradeoff: an unkeyed digest of a low-entropy value, such as a short memory key or a subject id, can be enumerated by anyone who can read the audit rows, because they can hash a dictionary of candidates and match. The secret defeats that. Set it out of band, never in code:

```bash
npx convex env set MEMORY_SIGNING_SECRET "$(openssl rand -hex 32)"
```

In every call below, `orgCode` is the server-verified tenant your app resolved from its own auth, not request input. The `subject` is the principal the operation acts for.

### Writing and recalling memory

`write` stores a tenant-stamped record. Supply an `embedding` alongside the content if you want the record to be recallable; the component never embeds on write.

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

For direct HTTP callers, the component needs a way to verify who is calling and resolve the tenant from the verified token, never from the request body. That is the `verifyCaller` slot. Wire it to the verifier from [`@kinde-oss/kinde-convex-agent-auth`](https://github.com/kinde-oss/kinde-convex-agent-auth), which validates the JWT and returns `{subject, agentId, orgCode, scopes, claims}`:

```ts
import {AgentMemory} from '@kinde-oss/kinde-convex-agent-memory';
import {verifyCaller} from '@kinde-oss/kinde-convex-agent-auth';
import {components} from './_generated/api';

export const agentMemory = new AgentMemory(components.memory, {verifyCaller});
```

The component imports no auth package. You compose them at the app level, and the `orgCode` that `verifyCaller` returns is the tenant the memory operations bind to. The example app ships a fake `verifyCaller` that maps a few test tokens to tenants; that fake is only a stand-in for this real one.

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
| `provenanceOf` | yes | no | n/a, returns no content | no | no |
| `inspectRevocation` | yes | no | n/a | no | no |

### Two caveats worth reading

The audit row's `keyOrQueryDigest` column has two meanings. For a normal operation it is a digest of the operation's key, filter, or target. For a denial whose `reasonCode` is `revoked`, it is instead the revocation target digest. That is deliberate: it is what lets you join a `revoked` denial to `inspectRevocation` and read the reason, while the reason itself never sits in the append-only log. If you read raw audit rows, know that this column changes meaning on a `revoked` row.

The Mastra vector adapter in the example is example-only. `example/convex/mastraAdapter.ts` shows the governed-vector pattern: a Mastra-shaped vector store whose reads and writes route through this component's client so recall stays tenant-bound, in contrast to an admin-keyed store that reads the tables from outside and cannot be governed. It is a demonstration of the pattern, not a drop-in replacement for `@mastra/convex`, and the shipped package depends on no Mastra package. Wire the pattern into your own Mastra setup.

### Composes with auth, billing, and tools

`@kinde-oss/kinde-convex-agent-memory` is a sibling of the other Kinde AgentKit components. Composition is app-level in every case, and this component imports none of them.

[`@kinde-oss/kinde-convex-agent-auth`](https://github.com/kinde-oss/kinde-convex-agent-auth) verifies agent tokens and resolves the tenant. You pass its `verifyCaller` into this component's config, and the `orgCode` it returns is the tenant memory binds to.

[`@kinde-oss/kinde-convex-agent-billing`](https://github.com/kinde-oss/kinde-convex-agent-billing) meters and bills agent activity. You call it from the same app functions that call memory, using the same verified tenant, so usage is attributed to the tenant that incurred it.

[`@kinde-oss/kinde-convex-agent-tools`](https://github.com/kinde-oss/kinde-convex-agent-tools) governs the tools an agent may call. It runs alongside memory in your app functions, with the same verified `subject` and `orgCode`, so a tool call and the memory it reads or writes share one tenant context.

## Documentation

For details, see the [Kinde docs](https://kinde.com/docs/), the [developer tools](https://kinde.com/docs/developer-tools/) section, and the [Convex components docs](https://docs.convex.dev/components).

## Publishing

The Kinde core team handles publishing.

## Contributing

Please refer to Kinde's [contributing guidelines](https://github.com/kinde-oss/.github/blob/489e2ca9c3307c2b2e098a885e22f2239116394a/CONTRIBUTING.md), [security policy](https://github.com/kinde-oss/.github/blob/main/SECURITY.md), and [code of conduct](https://github.com/kinde-oss/.github/blob/main/CODE_OF_CONDUCT.md).

## License

By contributing to Kinde, you agree that your contributions will be licensed under its MIT License.
