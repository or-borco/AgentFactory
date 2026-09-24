import { createLogger } from "@agentfactory/logger";
import { parseDependencyCacheVolumeName } from "./sandbox-cache";

const log = createLogger("dependency-cache-reap");

const DAY_MS = 24 * 60 * 60 * 1000;
const GB = 1024 * 1024 * 1024;

export const DEPENDENCY_CACHE_MAX_AGE_MS = Number(process.env.DEPENDENCY_CACHE_MAX_AGE_DAYS ?? 14) * DAY_MS;
export const DEPENDENCY_CACHE_MAX_BYTES = Number(process.env.DEPENDENCY_CACHE_MAX_GB ?? 10) * GB;

export interface CacheVolumeInfo {
  name: string;
  createdAt: Date;
  inUse: boolean;
  sizeBytes?: number;
}

export interface CacheVolumeStore {
  list(): Promise<CacheVolumeInfo[]>;
  remove(name: string): Promise<void>;
}

export type CacheVolumeRemovalReason = "org_deleted" | "legacy_org_wide" | "expired" | "oversized";

export interface CacheVolumeRemoval {
  name: string;
  reason: CacheVolumeRemovalReason;
}

export interface CacheReapPolicy {
  orgExists: (orgId: number) => boolean;
  now: number;
  maxAgeMs: number;
  maxSizeBytes: number;
}

export function selectCacheVolumesToRemove(volumes: CacheVolumeInfo[], policy: CacheReapPolicy): CacheVolumeRemoval[] {
  const removals: CacheVolumeRemoval[] = [];
  for (const volume of volumes) {
    if (volume.inUse) continue;
    const parsed = parseDependencyCacheVolumeName(volume.name);
    if (!parsed) continue;
    const reason: CacheVolumeRemovalReason | undefined = !policy.orgExists(parsed.orgId)
      ? "org_deleted"
      : !parsed.perRepo
        ? "legacy_org_wide"
        : policy.now - volume.createdAt.getTime() > policy.maxAgeMs
          ? "expired"
          : volume.sizeBytes !== undefined && volume.sizeBytes > policy.maxSizeBytes
            ? "oversized"
            : undefined;
    if (reason) removals.push({ name: volume.name, reason });
  }
  return removals;
}

export interface ReapDependencyCachesOptions {
  store: CacheVolumeStore;
  orgExists: (orgId: number) => Promise<boolean>;
  now?: number;
  maxAgeMs?: number;
  maxSizeBytes?: number;
}

export async function reapDependencyCaches(options: ReapDependencyCachesOptions): Promise<CacheVolumeRemoval[]> {
  const volumes = await options.store.list();
  const orgIds = new Set<number>();
  for (const volume of volumes) {
    const parsed = parseDependencyCacheVolumeName(volume.name);
    if (parsed && !volume.inUse) orgIds.add(parsed.orgId);
  }
  const existing = new Set<number>();
  for (const orgId of orgIds) {
    if (await options.orgExists(orgId)) existing.add(orgId);
  }

  const selected = selectCacheVolumesToRemove(volumes, {
    orgExists: (orgId) => existing.has(orgId),
    now: options.now ?? Date.now(),
    maxAgeMs: options.maxAgeMs ?? DEPENDENCY_CACHE_MAX_AGE_MS,
    maxSizeBytes: options.maxSizeBytes ?? DEPENDENCY_CACHE_MAX_BYTES,
  });

  const removed: CacheVolumeRemoval[] = [];
  for (const removal of selected) {
    try {
      await options.store.remove(removal.name);
      removed.push(removal);
      log.info("Removed dependency cache volume", { ...removal });
    } catch (err) {
      log.warn("Could not remove dependency cache volume", { ...removal, err });
    }
  }
  return removed;
}
