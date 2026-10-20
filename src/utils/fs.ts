import { config } from "../../package.json";
import { log } from "./log";

type AnyGlobal = typeof globalThis & {
  PathUtils?: {
    join: (...parts: string[]) => string;
    homeDir?: string;
    tempDir?: string;
  };
  IOUtils?: {
    exists: (path: string) => Promise<boolean>;
    makeDirectory: (
      path: string,
      options?: { createAncestors?: boolean; ignoreExisting?: boolean },
    ) => Promise<void>;
    readUTF8: (path: string) => Promise<string>;
    writeUTF8: (path: string, data: string) => Promise<void>;
    readJSON: (path: string) => Promise<unknown>;
    writeJSON: (path: string, data: unknown) => Promise<void>;
    read: (path: string) => Promise<Uint8Array>;
    write: (path: string, data: Uint8Array) => Promise<void>;
    remove: (path: string, options?: { recursive?: boolean }) => Promise<void>;
  };
  Services?: {
    dirsvc?: {
      get: (key: string, iface: unknown) => { path: string };
    };
  };
  Ci?: { nsIFile: unknown };
};

export function getGlobal(): AnyGlobal {
  return globalThis as AnyGlobal;
}

/** Directory under the Zotero data directory where PaperMiner stores data. */
export function getPluginDataDir(): string {
  const pu = getGlobal().PathUtils;
  const base = Zotero.DataDirectory.dir;
  const folder = pu
    ? pu.join(base, config.addonRef)
    : `${base}/${config.addonRef}`;
  return folder;
}

export function joinPath(...parts: string[]): string {
  const pu = getGlobal().PathUtils;
  if (pu?.join) return pu.join(...parts);
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

export async function ensureDir(path: string): Promise<void> {
  const io = getGlobal().IOUtils;
  if (!io) return;
  try {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
  } catch (error) {
    log("ensureDir failed:", path, error);
  }
}

export async function fileExists(path: string): Promise<boolean> {
  const io = getGlobal().IOUtils;
  if (!io) return false;
  try {
    return await io.exists(path);
  } catch {
    return false;
  }
}

export async function readJSONFile<T>(path: string, fallback: T): Promise<T> {
  const io = getGlobal().IOUtils;
  if (!io) return fallback;
  try {
    if (!(await io.exists(path))) return fallback;
    const data = (await io.readJSON(path)) as T;
    return data ?? fallback;
  } catch (error) {
    log("readJSONFile failed:", path, error);
    return fallback;
  }
}

export async function writeJSONFile(
  path: string,
  data: unknown,
): Promise<void> {
  const io = getGlobal().IOUtils;
  if (!io) return;
  try {
    await io.writeJSON(path, data);
  } catch (error) {
    log("writeJSONFile failed:", path, error);
  }
}

export async function readTextFile(path: string): Promise<string> {
  const io = getGlobal().IOUtils;
  if (!io) return "";
  try {
    return await io.readUTF8(path);
  } catch (error) {
    log("readTextFile failed:", path, error);
    return "";
  }
}

export async function writeTextFile(path: string, text: string): Promise<void> {
  const io = getGlobal().IOUtils;
  if (!io) return;
  await io.writeUTF8(path, text);
}

export async function writeBinaryFile(
  path: string,
  data: Uint8Array,
): Promise<void> {
  const io = getGlobal().IOUtils;
  if (!io) return;
  await io.write(path, data);
}

export async function ensurePluginDataDir(): Promise<string> {
  const dir = getPluginDataDir();
  await ensureDir(dir);
  return dir;
}

/** Best-effort downloads directory, used for generated .pptx files. */
export function getDownloadsDir(): string {
  const g = getGlobal();
  try {
    const home =
      g.PathUtils?.homeDir ||
      g.Services?.dirsvc?.get("Home", g.Ci?.nsIFile)?.path ||
      "";
    if (home) {
      return joinPath(home, "Downloads");
    }
  } catch (error) {
    log("getDownloadsDir failed:", error);
  }
  try {
    return Zotero.getTempDirectory().path;
  } catch {
    return getPluginDataDir();
  }
}

/** Remove characters that are unsafe in common file systems. */
export function sanitizeFilename(name: string, maxLength = 90): string {
  const cleaned = (name || "paper")
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  return cleaned.slice(0, maxLength) || "paper";
}

/** Launch a local file with the system default application. */
export function launchFile(path: string): void {
  try {
    Zotero.launchFile(path);
  } catch (error) {
    log("launchFile failed:", path, error);
  }
}

export function revealFile(path: string): void {
  try {
    Zotero.File.reveal(path);
  } catch (error) {
    log("revealFile failed:", path, error);
  }
}
