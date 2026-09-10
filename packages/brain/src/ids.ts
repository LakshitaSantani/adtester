import { randomBytes, randomUUID } from "node:crypto";

/** URL-safe, unguessable, and short enough to read out loud if you must. */
function token(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

export const newSessionId = (): string => randomUUID().replace(/-/g, "");
export const newProjectId = (): string => `prj_${token(8)}`;
export const newInstallKey = (): string => `key_${token(9)}`;
export const newViewToken = (): string => `v_${token(18)}`;
/** Longer than the view token: it is the one that can spend money. */
export const newAdminToken = (): string => `a_${token(24)}`;
export const newId = (prefix: string): string => `${prefix}_${token(8)}`;

/**
 * CORS. The recorder runs on the customer's domain, so the ingest endpoints
 * must allow any origin — without this every request fails silently and it
 * looks like the recorder is broken.
 *
 * This is safe here because the endpoints are append-only, take an install
 * key that is already public, and return nothing readable. The read endpoints
 * are NOT wrapped in this.
 */
export const INGEST_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Content-Encoding",
  "Access-Control-Max-Age": "86400",
} as const;
