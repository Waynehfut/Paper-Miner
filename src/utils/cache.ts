import { config } from "../../package.json";
import { getPluginDataDir, joinPath, readJSONFile, writeJSONFile } from "./fs";
import { log } from "./log";

interface CacheEntry {
  /** Timestamp (ms) when the value was stored. */
  t: number;
  v: unknown;
}

interface CacheFile {
  version: number;
  namespaces: Record<string, Record<string, CacheEntry>>;
}

const CACHE_FILE_NAME = "cache.json";
const CACHE_VERSION = 1;

/**
 * A tiny persistent JSON cache shared by journal-rank and retraction lookups.
 * All access is in-memory after a lazy load; writes are debounced.
 */
class PluginCache {
  private data: CacheFile = { version: CACHE_VERSION, namespaces: {} };
  private loaded = false;
  private loading: Promise<void> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingWrite = false;

  private get path(): string {
    return joinPath(getPluginDataDir(), CACHE_FILE_NAME);
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const data = await readJSONFile<CacheFile>(this.path, {
        version: CACHE_VERSION,
        namespaces: {},
      });
      if (data && data.version === CACHE_VERSION && data.namespaces) {
        this.data = data;
      }
      this.loaded = true;
      this.loading = null;
    })();
    await this.loading;
  }

  async get<T>(
    namespace: string,
    key: string,
    ttlDays?: number,
  ): Promise<T | undefined> {
    await this.init();
    const entry = this.data.namespaces[namespace]?.[key];
    if (!entry) return undefined;
    if (ttlDays && ttlDays > 0) {
      const ageMs = Date.now() - entry.t;
      if (ageMs > ttlDays * 24 * 60 * 60 * 1000) {
        delete this.data.namespaces[namespace][key];
        this.scheduleWrite();
        return undefined;
      }
    }
    return entry.v as T;
  }

  async set(namespace: string, key: string, value: unknown): Promise<void> {
    await this.init();
    this.data.namespaces[namespace] ||= {};
    this.data.namespaces[namespace][key] = { t: Date.now(), v: value };
    this.scheduleWrite();
  }

  async delete(namespace: string, key: string): Promise<void> {
    await this.init();
    if (this.data.namespaces[namespace]?.[key]) {
      delete this.data.namespaces[namespace][key];
      this.scheduleWrite();
    }
  }

  async clear(namespace?: string): Promise<void> {
    await this.init();
    if (namespace) {
      delete this.data.namespaces[namespace];
    } else {
      this.data.namespaces = {};
    }
    this.scheduleWrite();
  }

  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.pendingWrite) return;
    this.pendingWrite = false;
    try {
      await writeJSONFile(this.path, this.data);
    } catch (error) {
      log("cache flush failed:", error);
    }
  }

  private scheduleWrite(): void {
    this.pendingWrite = true;
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.flush();
    }, 400);
  }
}

export const pluginCache = new PluginCache();

export const CACHE_NAMESPACES = {
  journal: "journal",
  retraction: "retraction",
} as const;

export const CACHE_PREFIX = config.addonRef;
