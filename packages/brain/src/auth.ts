/**
 * Two links per project, not one.
 *
 * Until now a single token did everything: read the recordings, change the
 * credentials, and spend the owner's Anthropic budget. That made "share this
 * with someone" and "let someone run this" the same act, which is wrong —
 * showing a colleague what the product found should not hand them the keys.
 *
 *   view  — read sessions, replays and reports.
 *   admin — everything view can do, plus setup, credentials, uploads and
 *           starting work that costs money.
 *
 * Both live in the same URL shape, so a page just asks for the level it needs
 * and a view link on an admin page is simply not found.
 *
 * This is not authentication. An unguessable URL is a bearer token, and
 * anybody it reaches has whatever it grants. It is honest for a handful of
 * people who know each other, and the split at least means the link you send
 * around is the harmless one.
 */

import { getDb } from "./db";

export type Level = "view" | "admin";

export type ProjectAccess = {
  id: string;
  name: string;
  installKey: string;
  /** True when the token used was the admin one. */
  isAdmin: boolean;
};

export async function resolveProject(
  token: string | null | undefined,
  need: Level,
): Promise<ProjectAccess | null> {
  if (!token) return null;
  const db = await getDb();

  const row = await db.one<{
    id: string;
    name: string;
    install_key: string;
    view_token: string;
    admin_token: string | null;
  }>(
    `SELECT id, name, install_key, view_token, admin_token
       FROM projects
      WHERE view_token = $1 OR admin_token = $1`,
    [token],
  );
  if (!row) return null;

  // Projects created before the split have no admin token; their view token
  // keeps its old powers so existing links don't break.
  const isAdmin = row.admin_token === null || row.admin_token === token;
  if (need === "admin" && !isAdmin) return null;

  return {
    id: row.id,
    name: row.name,
    installKey: row.install_key,
    isAdmin,
  };
}
