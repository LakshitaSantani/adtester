/**
 * Encrypting the credentials people paste in.
 *
 * This protects one specific thing: a database file that ends up somewhere it
 * shouldn't — a backup, a laptop, a copied volume. It does NOT protect
 * against someone who can run code on the server, because the key lives
 * there too. That is the honest boundary, and the real fix above it is not
 * holding customer credentials at all.
 *
 * AES-256-GCM, so tampering is detected rather than silently decrypting to
 * rubbish.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const PREFIX = "enc.v1.";
const DATA_DIR = process.env.DATA_DIR ?? "./data";

let cachedKey: Buffer | null = null;

/**
 * The key comes from SWY_SECRET, or a file generated on first use.
 *
 * Generating one means encryption is on by default rather than something an
 * operator has to remember. The file sits beside the database, so anyone who
 * can read one can read the other — which is exactly the boundary described
 * above, and why SWY_SECRET (kept somewhere else) is better when it matters.
 */
function key(): Buffer {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.SWY_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedKey = createHash("sha256").update(fromEnv).digest();
    return cachedKey;
  }

  const keyPath = path.resolve(DATA_DIR, "secret.key");
  try {
    if (existsSync(keyPath)) {
      cachedKey = createHash("sha256").update(readFileSync(keyPath, "utf8")).digest();
      return cachedKey;
    }
    mkdirSync(path.dirname(keyPath), { recursive: true });
    const generated = randomBytes(32).toString("hex");
    writeFileSync(keyPath, generated, { mode: 0o600 });
    console.log(
      "crypto: generated a local encryption key in data/secret.key. " +
        "Set SWY_SECRET instead to keep it away from the database.",
    );
    cachedKey = createHash("sha256").update(generated).digest();
    return cachedKey;
  } catch (error) {
    // A read-only filesystem shouldn't take the app down; fall back to a
    // process-lifetime key and say so, because stored values won't survive
    // a restart.
    console.warn(
      "crypto: could not persist an encryption key, using a temporary one. " +
        "Saved credentials will not survive a restart.",
      error,
    );
    cachedKey = randomBytes(32);
    return cachedKey;
  }
}

export function encrypt(plain: string): string {
  if (!plain) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}.${tag.toString("base64url")}.${body.toString("base64url")}`;
}

/**
 * Decrypt, passing through anything that isn't encrypted.
 *
 * Values written before encryption existed are stored in the clear, and a
 * migration that fails halfway would leave both kinds side by side. Reading
 * both means rolling this out doesn't need a migration at all.
 */
export function decrypt(value: string | null): string | null {
  if (!value) return value;
  if (!value.startsWith(PREFIX)) return value;

  try {
    const [ivPart, tagPart, bodyPart] = value.slice(PREFIX.length).split(".");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key(),
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Wrong key, or tampered ciphertext. Treat as absent rather than
    // throwing — a credential that can't be read should look missing, which
    // the callers already handle.
    console.warn("crypto: could not decrypt a stored value");
    return null;
  }
}
