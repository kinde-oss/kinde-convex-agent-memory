/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as example from "../example.js";
import type * as http from "../http.js";
import type * as langchainAdapter from "../langchainAdapter.js";
import type * as live_openaiEmbedder from "../live/openaiEmbedder.js";
import type * as live_verify from "../live/verify.js";
import type * as llamaindexAdapter from "../llamaindexAdapter.js";
import type * as mastraAdapter from "../mastraAdapter.js";
import type * as openaiAgentsAdapter from "../openaiAgentsAdapter.js";
import type * as vercelAdapter from "../vercelAdapter.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  example: typeof example;
  http: typeof http;
  langchainAdapter: typeof langchainAdapter;
  "live/openaiEmbedder": typeof live_openaiEmbedder;
  "live/verify": typeof live_verify;
  llamaindexAdapter: typeof llamaindexAdapter;
  mastraAdapter: typeof mastraAdapter;
  openaiAgentsAdapter: typeof openaiAgentsAdapter;
  vercelAdapter: typeof vercelAdapter;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  memory: import("@kinde-oss/kinde-convex-agent-memory/_generated/component.js").ComponentApi<"memory">;
};
