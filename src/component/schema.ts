import {defineSchema} from 'convex/server';

/**
 * Empty-but-valid schema (P0 scaffold). The memory tables — structured records
 * with immutable provenance, tenant-keyed indexes, and vector embeddings for
 * semantic recall — arrive in later phases. Every index added here must lead
 * with the tenant key so no read path can cross the org boundary.
 */
export default defineSchema({});
