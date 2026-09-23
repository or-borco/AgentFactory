import { randomBytes } from "node:crypto";
import type { ModelSpec } from "@agentfactory/core";

export type RunCredentialPurpose = "run" | "repo-map";

export type ModelProvider = ModelSpec["family"];

export interface RunCredentialContext {
  orgId: number;
  runId?: number;
  purpose: RunCredentialPurpose;
  provider: ModelProvider;
}

interface RunCredentialEntry extends RunCredentialContext {
  expiresAt: number;
}

export const RUN_CREDENTIAL_PREFIX = "arata-run-";
export const MAX_RUN_CREDENTIAL_TTL_MS = 2 * 60 * 60 * 1000;

export class RunCredentialStore {
  private readonly entries = new Map<string, RunCredentialEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(context: RunCredentialContext, ttlMs: number = MAX_RUN_CREDENTIAL_TTL_MS): string {
    this.purgeExpired();
    const token = `${RUN_CREDENTIAL_PREFIX}${randomBytes(32).toString("base64url")}`;
    const lifetime = Math.min(Math.max(ttlMs, 0), MAX_RUN_CREDENTIAL_TTL_MS);
    this.entries.set(token, { ...context, expiresAt: this.now() + lifetime });
    return token;
  }

  resolve(token: string | undefined): RunCredentialContext | undefined {
    if (!token) return undefined;
    const entry = this.entries.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(token);
      return undefined;
    }
    const { expiresAt: _expiresAt, ...context } = entry;
    return context;
  }

  revoke(token: string): void {
    this.entries.delete(token);
  }

  size(): number {
    this.purgeExpired();
    return this.entries.size;
  }

  private purgeExpired(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(token);
    }
  }
}
