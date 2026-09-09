/**
 * Credentials a project supplies during setup.
 *
 * Three different services, three keys, all pasted by whoever is trying the
 * product. They live in the `data_sources` table alongside the rest of a
 * connection's config.
 *
 * Stored in plain text in the database, which is honest for a prototype run
 * by people who know each other and wrong for anything else. Two rules keep
 * it from being worse than it needs to be: a key is never returned by any
 * API, and anything shown back is a masked hint rather than the value.
 * Encryption at rest, and not holding customer keys at all, are phase 6
 * problems — see the note in the setup page.
 */

import { getDb } from "./db";
import { newId } from "./ids";

export type SecretKind = "anthropic";

export async function saveSecret(
  projectId: string,
  kind: SecretKind,
  value: string,
): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO data_sources (id, project_id, kind, config)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (project_id, kind) DO UPDATE SET config = EXCLUDED.config, last_error = NULL`,
    [newId("src"), projectId, kind, JSON.stringify({ key: value })],
  );
}

export async function getSecret(
  projectId: string,
  kind: SecretKind,
): Promise<string | null> {
  const db = await getDb();
  const row = await db.one<{ config: Record<string, unknown> | string }>(
    `SELECT config FROM data_sources WHERE project_id = $1 AND kind = $2`,
    [projectId, kind],
  );
  if (!row) return null;
  const config = typeof row.config === "string" ? JSON.parse(row.config) : row.config;
  const key = (config as { key?: unknown }).key;
  return typeof key === "string" && key.trim() ? key : null;
}

/**
 * The key to use for a project: its own, else the server's.
 *
 * Falling back to the environment means a self-hosted install can set one key
 * for everybody and never ask, while a shared instance can ask each person
 * for their own and never pay for their usage.
 */
export async function resolveAnthropicKey(projectId: string): Promise<string | null> {
  return (await getSecret(projectId, "anthropic")) ?? process.env.ANTHROPIC_API_KEY ?? null;
}

/** Enough to recognise a key you pasted, useless to anyone who sees it. */
export function maskKey(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 7)}…${value.slice(-4)}`;
}
