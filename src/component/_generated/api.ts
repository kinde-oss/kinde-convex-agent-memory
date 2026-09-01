/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access from "../access.js";
import type * as audit from "../audit.js";
import type * as grants from "../grants.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_correlation from "../lib/correlation.js";
import type * as lib_digest from "../lib/digest.js";
import type * as lib_embedding from "../lib/embedding.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_grantStore from "../lib/grantStore.js";
import type * as lib_redaction from "../lib/redaction.js";
import type * as lib_revocationStore from "../lib/revocationStore.js";
import type * as memory from "../memory.js";
import type * as policy from "../policy.js";
import type * as provenance from "../provenance.js";
import type * as revocations from "../revocations.js";
import type * as validators from "../validators.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  access: typeof access;
  audit: typeof audit;
  grants: typeof grants;
  "lib/audit": typeof lib_audit;
  "lib/correlation": typeof lib_correlation;
  "lib/digest": typeof lib_digest;
  "lib/embedding": typeof lib_embedding;
  "lib/errors": typeof lib_errors;
  "lib/grantStore": typeof lib_grantStore;
  "lib/redaction": typeof lib_redaction;
  "lib/revocationStore": typeof lib_revocationStore;
  memory: typeof memory;
  policy: typeof policy;
  provenance: typeof provenance;
  revocations: typeof revocations;
  validators: typeof validators;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {};
