/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    audit: {
      query: FunctionReference<
        "query",
        "internal",
        {
          claimedOrgCode?: string;
          filter?: {
            correlationId?: string;
            decision?: "ok" | "denied";
            operation?:
              | "write"
              | "get"
              | "list"
              | "recall"
              | "grant"
              | "revoke_grant"
              | "set_redaction"
              | "revoke"
              | "lift_revocation";
            since?: number;
            subject?: string;
            until?: number;
          };
          orgCode: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            _creationTime: number;
            _id: string;
            correlationId: string;
            decision: "ok" | "denied";
            keyOrQueryDigest: string;
            mandateId: string | null;
            operation:
              | "write"
              | "get"
              | "list"
              | "recall"
              | "grant"
              | "revoke_grant"
              | "set_redaction"
              | "revoke"
              | "lift_revocation";
            orgCode: string;
            reasonCode:
              | "created"
              | "updated"
              | "idempotent_replay"
              | "found"
              | "not_found"
              | "listed"
              | "recalled"
              | "granted"
              | "already_granted"
              | "revoked"
              | "redaction_set"
              | "redaction_cleared"
              | "tenant_context_conflict"
              | "idempotency_key_reused"
              | "key_owned_by_other_subject"
              | "invalid_filter"
              | "invalid_embedding"
              | "invalid_topk"
              | "scope_not_granted"
              | "grant_not_found"
              | "policy_not_found"
              | "invalid_redaction_fields"
              | "revocation_created"
              | "already_revoked"
              | "revocation_lifted"
              | "revocation_not_found"
              | "invalid_revocation_target";
            subject: string;
            ts: number;
          }>;
        },
        Name
      >;
    };
    grants: {
      grant: FunctionReference<
        "mutation",
        "internal",
        {
          claimedOrgCode?: string;
          correlationId?: string;
          orgCode: string;
          scope: "memory.read" | "memory.write" | "memory.recall";
          subject: string;
          targetSubject: string;
        },
        | {
            correlationId: string;
            grantId: string;
            ok: true;
            outcome: "granted" | "already_granted";
          }
        | {
            code:
              | "tenant_context_conflict"
              | "idempotency_key_reused"
              | "key_owned_by_other_subject"
              | "invalid_filter"
              | "invalid_embedding"
              | "invalid_topk"
              | "scope_not_granted"
              | "grant_not_found"
              | "policy_not_found"
              | "invalid_redaction_fields"
              | "revoked"
              | "revocation_not_found"
              | "invalid_revocation_target";
            correlationId: string;
            message: string;
            ok: false;
          },
        Name
      >;
      revokeGrant: FunctionReference<
        "mutation",
        "internal",
        {
          claimedOrgCode?: string;
          correlationId?: string;
          orgCode: string;
          scope: "memory.read" | "memory.write" | "memory.recall";
          subject: string;
          targetSubject: string;
        },
        | { correlationId: string; grantId: string; ok: true }
        | {
            code:
              | "tenant_context_conflict"
              | "idempotency_key_reused"
              | "key_owned_by_other_subject"
              | "invalid_filter"
              | "invalid_embedding"
              | "invalid_topk"
              | "scope_not_granted"
              | "grant_not_found"
              | "policy_not_found"
              | "invalid_redaction_fields"
              | "revoked"
              | "revocation_not_found"
              | "invalid_revocation_target";
            correlationId: string;
            message: string;
            ok: false;
          },
        Name
      >;
    };
    memory: {
      get: FunctionReference<
        "mutation",
        "internal",
        {
          claimedOrgCode?: string;
          correlationId?: string;
          key: string;
          orgCode: string;
          subject: string;
        },
        | {
            correlationId: string;
            memory: {
              _creationTime: number;
              _id: string;
              content: string;
              createdAt: number;
              createdBy: string;
              embedding?: Array<number>;
              idempotencyKey: string | null;
              key: string;
              mandateId: string | null;
              metadata?: Record<
                string,
                | string
                | number
                | boolean
                | null
                | Array<string | number | boolean | null>
              >;
              orgCode: string;
              subject: string;
              writtenAt: number;
              writtenBy: string;
            } | null;
            ok: true;
          }
        | {
            code:
              | "tenant_context_conflict"
              | "idempotency_key_reused"
              | "key_owned_by_other_subject"
              | "invalid_filter"
              | "invalid_embedding"
              | "invalid_topk"
              | "scope_not_granted"
              | "grant_not_found"
              | "policy_not_found"
              | "invalid_redaction_fields"
              | "revoked"
              | "revocation_not_found"
              | "invalid_revocation_target";
            correlationId: string;
            message: string;
            ok: false;
          },
        Name
      >;
      list: FunctionReference<
        "mutation",
        "internal",
        {
          claimedOrgCode?: string;
          correlationId?: string;
          filter?: {
            bySubject?: string;
            keyPrefix?: string;
            metadataEquals?: {
              field: string;
              value: string | number | boolean | null;
            };
            writtenAfter?: number;
            writtenBefore?: number;
          };
          orgCode: string;
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          subject: string;
        },
        | {
            continueCursor: string;
            correlationId: string;
            isDone: boolean;
            ok: true;
            page: Array<{
              _creationTime: number;
              _id: string;
              content: string;
              createdAt: number;
              createdBy: string;
              embedding?: Array<number>;
              idempotencyKey: string | null;
              key: string;
              mandateId: string | null;
              metadata?: Record<
                string,
                | string
                | number
                | boolean
                | null
                | Array<string | number | boolean | null>
              >;
              orgCode: string;
              subject: string;
              writtenAt: number;
              writtenBy: string;
            }>;
          }
        | {
            code:
              | "tenant_context_conflict"
              | "idempotency_key_reused"
              | "key_owned_by_other_subject"
              | "invalid_filter"
              | "invalid_embedding"
              | "invalid_topk"
              | "scope_not_granted"
              | "grant_not_found"
              | "policy_not_found"
              | "invalid_redaction_fields"
              | "revoked"
              | "revocation_not_found"
              | "invalid_revocation_target";
            correlationId: string;
            message: string;
            ok: false;
          },
        Name
      >;
      recall: FunctionReference<
        "action",
        "internal",
        {
          claimedOrgCode?: string;
          correlationId?: string;
          embedding: Array<number>;
          orgCode: string;
          subject: string;
          topK: number;
        },
        | {
            correlationId: string;
            matches: Array<{
              memory: {
                _creationTime: number;
                _id: string;
                content: string;
                createdAt: number;
                createdBy: string;
                embedding?: Array<number>;
                idempotencyKey: string | null;
                key: string;
                mandateId: string | null;
                metadata?: Record<
                  string,
                  | string
                  | number
                  | boolean
                  | null
                  | Array<string | number | boolean | null>
                >;
                orgCode: string;
                subject: string;
                writtenAt: number;
                writtenBy: string;
              };
              score: number;
            }>;
            ok: true;
          }
        | {
            code:
              | "tenant_context_conflict"
              | "idempotency_key_reused"
              | "key_owned_by_other_subject"
              | "invalid_filter"
              | "invalid_embedding"
              | "invalid_topk"
              | "scope_not_granted"
              | "grant_not_found"
              | "policy_not_found"
              | "invalid_redaction_fields"
              | "revoked"
              | "revocation_not_found"
              | "invalid_revocation_target";
            correlationId: string;
            message: string;
            ok: false;
          },
        Name
      >;
      write: FunctionReference<
        "mutation",
        "internal",
        {
          claimedOrgCode?: string;
          content: string;
          correlationId?: string;
          embedding?: Array<number>;
          idempotencyKey?: string;
          key: string;
          metadata?: Record<
            string,
            | string
            | number
            | boolean
            | null
            | Array<string | number | boolean | null>
          >;
          orgCode: string;
          subject: string;
        },
        | {
            correlationId: string;
            memoryId: string;
            ok: true;
            outcome: "created" | "updated" | "idempotent_replay";
          }
        | {
            code:
              | "tenant_context_conflict"
              | "idempotency_key_reused"
              | "key_owned_by_other_subject"
              | "invalid_filter"
              | "invalid_embedding"
              | "invalid_topk"
              | "scope_not_granted"
              | "grant_not_found"
              | "policy_not_found"
              | "invalid_redaction_fields"
              | "revoked"
              | "revocation_not_found"
              | "invalid_revocation_target";
            correlationId: string;
            message: string;
            ok: false;
          },
        Name
      >;
    };
    policy: {
      setRedaction: FunctionReference<
        "mutation",
        "internal",
        {
          claimedOrgCode?: string;
          correlationId?: string;
          fields: Array<string>;
          orgCode: string;
          subject: string;
          targetSubject?: string;
        },
        | { correlationId: string; ok: true; outcome: "set" | "cleared" }
        | {
            code:
              | "tenant_context_conflict"
              | "idempotency_key_reused"
              | "key_owned_by_other_subject"
              | "invalid_filter"
              | "invalid_embedding"
              | "invalid_topk"
              | "scope_not_granted"
              | "grant_not_found"
              | "policy_not_found"
              | "invalid_redaction_fields"
              | "revoked"
              | "revocation_not_found"
              | "invalid_revocation_target";
            correlationId: string;
            message: string;
            ok: false;
          },
        Name
      >;
    };
    provenance: {
      of: FunctionReference<
        "query",
        "internal",
        {
          claimedOrgCode?: string;
          correlationId?: string;
          memoryId: string;
          orgCode: string;
        },
        {
          createdAt: number;
          createdBy: string;
          key: string;
          mandateId: string | null;
          memoryId: string;
          orgCode: string;
          subject: string;
          writtenAt: number;
          writtenBy: string;
        } | null,
        Name
      >;
    };
    revocations: {
      inspect: FunctionReference<
        "query",
        "internal",
        {
          claimedOrgCode?: string;
          orgCode: string;
          target: {
            kind: "global" | "org" | "subject";
            orgCode?: string;
            subject?: string;
          };
        },
        {
          revocations: Array<{
            _creationTime: number;
            _id: string;
            kind: "global" | "org" | "subject";
            liftedAt: number | null;
            liftedBy: string | null;
            orgCode: string | null;
            reason: string;
            revokedAt: number;
            revokedBy: string;
            subject: string | null;
          }>;
          targetDigest: string;
        },
        Name
      >;
      liftRevocation: FunctionReference<
        "mutation",
        "internal",
        {
          claimedOrgCode?: string;
          correlationId?: string;
          orgCode: string;
          subject: string;
          target: {
            kind: "global" | "org" | "subject";
            orgCode?: string;
            subject?: string;
          };
        },
        | { correlationId: string; ok: true; revocationId: string }
        | {
            code:
              | "tenant_context_conflict"
              | "idempotency_key_reused"
              | "key_owned_by_other_subject"
              | "invalid_filter"
              | "invalid_embedding"
              | "invalid_topk"
              | "scope_not_granted"
              | "grant_not_found"
              | "policy_not_found"
              | "invalid_redaction_fields"
              | "revoked"
              | "revocation_not_found"
              | "invalid_revocation_target";
            correlationId: string;
            message: string;
            ok: false;
          },
        Name
      >;
      revoke: FunctionReference<
        "mutation",
        "internal",
        {
          claimedOrgCode?: string;
          correlationId?: string;
          orgCode: string;
          reason: string;
          subject: string;
          target: {
            kind: "global" | "org" | "subject";
            orgCode?: string;
            subject?: string;
          };
        },
        | {
            correlationId: string;
            ok: true;
            outcome: "revoked" | "already_revoked";
            revocationId: string;
          }
        | {
            code:
              | "tenant_context_conflict"
              | "idempotency_key_reused"
              | "key_owned_by_other_subject"
              | "invalid_filter"
              | "invalid_embedding"
              | "invalid_topk"
              | "scope_not_granted"
              | "grant_not_found"
              | "policy_not_found"
              | "invalid_redaction_fields"
              | "revoked"
              | "revocation_not_found"
              | "invalid_revocation_target";
            correlationId: string;
            message: string;
            ok: false;
          },
        Name
      >;
    };
  };
