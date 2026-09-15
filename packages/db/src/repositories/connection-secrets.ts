import { and, eq } from "drizzle-orm";
import { db } from "../client";
import { CURRENT_KEY_VERSION, decryptSecret, encryptSecret } from "../crypto";
import { connectionSecrets } from "../schema";

/** Encrypts and stores `plaintext`, stamped with the current key version. Returns the new row's id. */
export async function createConnectionSecret(orgId: number, plaintext: Record<string, string>): Promise<number> {
  const [row] = await db
    .insert(connectionSecrets)
    .values({
      orgId,
      ciphertext: encryptSecret(plaintext),
      keyVersion: CURRENT_KEY_VERSION,
    })
    .returning({ id: connectionSecrets.id });
  return row.id;
}

/**
 * Reads and decrypts a secret, org-scoped. Returns `undefined` for a missing or wrong-org row.
 * Throws (does not swallow) if `decryptSecret` fails — that means a key mismatch or tampering,
 * which must surface as an error rather than be indistinguishable from "no such row".
 */
export async function readConnectionSecret(orgId: number, id: number): Promise<Record<string, string> | undefined> {
  const [row] = await db
    .select()
    .from(connectionSecrets)
    .where(and(eq(connectionSecrets.orgId, orgId), eq(connectionSecrets.id, id)));
  if (!row) return undefined;
  return decryptSecret(row.ciphertext);
}

/** Org-scoped delete. A wrong-org or missing id is a no-op, matching the other repositories' delete semantics. */
export async function deleteConnectionSecret(orgId: number, id: number): Promise<void> {
  await db.delete(connectionSecrets).where(and(eq(connectionSecrets.orgId, orgId), eq(connectionSecrets.id, id)));
}
