import "server-only";
import { lstat, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DomainError } from "../domain-error";

// Where product photo files live. One small interface, so a hosting-compatible store (object storage) can
// replace the local folder later without touching the catalogue code. Only the local development adapter
// exists: a folder the operator names in MEDIA_STORAGE_DIR, outside the repository (so photos are never
// committed or served as public files). Keys are random (newStorageKey), never a name a user typed, and every
// key is checked against KEY before it touches the file system, so no path can escape the folder.

export type MediaStore = {
  /** Writes a new file atomically (temporary file, flush, rename); never overwrites. */
  put(key: string, data: Buffer): Promise<void>;
  /** The file's bytes, or null if it does not exist. */
  read(key: string): Promise<Buffer | null>;
  /** Deletes the file; a missing file is not an error. */
  remove(key: string): Promise<void>;
  /** Every entry name in the store, for the manifest check (including unexpected and partial ones). */
  entries(): Promise<string[]>;
  /** What an entry is (a regular file or something else, such as a link or folder) and when it last changed. */
  info(name: string): Promise<{ regularFile: boolean; modifiedMs: number } | null>;
};

export const STORAGE_KEY = /^[0-9a-f]{32}\.(jpg|png|webp)$/;

function checkedKey(key: string): string {
  if (typeof key !== "string" || !STORAGE_KEY.test(key)) throw new Error("Invalid media storage key.");
  return key;
}

export function localMediaStore(dir: string): MediaStore {
  const file = (key: string) => path.join(dir, checkedKey(key));
  return {
    async put(key, data) {
      const target = file(key);
      const partial = `${target}.partial`;
      try {
        const handle = await open(partial, "wx", 0o600);
        try {
          await handle.writeFile(data);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(partial, target);
      } catch (error) {
        await rm(partial, { force: true }).catch(() => undefined);
        throw error;
      }
    },
    async read(key) {
      try {
        // Never follow a link or read a folder placed under a photo's name: only a regular file counts.
        if (!(await lstat(file(key))).isFile()) return null;
        return await readFile(file(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async remove(key) {
      await rm(file(key), { force: true });
    },
    async entries() {
      return readdir(dir);
    },
    async info(name) {
      if (typeof name !== "string" || name === "" || name === "." || name === ".." || /[\\/]/.test(name)) throw new Error("Invalid media entry name.");
      try {
        const s = await lstat(path.join(dir, name));
        return { regularFile: s.isFile(), modifiedMs: s.mtimeMs };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
  };
}

export type MediaStoreConfig = { ok: true; store: MediaStore; dir: string } | { ok: false; problem: string };

/**
 * The configured store, or why there is none. MEDIA_STORAGE_DIR must be an absolute path to an existing folder
 * outside the project folder. In production the local adapter is refused unless MEDIA_LOCAL_STORAGE_IN_PRODUCTION
 * is "allow": a serverless or container host may not keep its disk, so using a local folder there is a
 * deployment decision, not a default. Messages name variables and rules, never the path.
 */
export function mediaStoreConfig(env: Record<string, string | undefined>, projectRoot: string): MediaStoreConfig {
  const raw = env.MEDIA_STORAGE_DIR;
  if (!raw) return { ok: false, problem: "MEDIA_STORAGE_DIR is not set, so photos cannot be stored." };
  if (!path.isAbsolute(raw)) return { ok: false, problem: "MEDIA_STORAGE_DIR must be an absolute path." };
  let dir: string;
  try {
    // Real paths, so a link cannot point the photo folder into the project (or a link inside it out of it).
    dir = realpathSync(path.resolve(raw));
    if (!statSync(dir).isDirectory()) return { ok: false, problem: "MEDIA_STORAGE_DIR is not a folder." };
  } catch {
    return { ok: false, problem: "MEDIA_STORAGE_DIR does not exist. Create the folder first." };
  }
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  let root = path.resolve(projectRoot);
  try {
    root = realpathSync(root);
  } catch {
    // keep the resolved path
  }
  const relative = path.relative(fold(root), fold(dir));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    return { ok: false, problem: "MEDIA_STORAGE_DIR must be outside the project folder (photos are never kept in the repository or public files)." };
  }
  if (env.NODE_ENV === "production" && env.MEDIA_LOCAL_STORAGE_IN_PRODUCTION !== "allow") {
    return { ok: false, problem: "Local media storage is refused in production unless MEDIA_LOCAL_STORAGE_IN_PRODUCTION=allow (only for a host whose disk is persistent and backed up)." };
  }
  return { ok: true, store: localMediaStore(dir), dir };
}

/** The application's store, from the environment; MEDIA_STORAGE_UNAVAILABLE (with the reason) without one. */
export function getMediaStore(): MediaStore {
  const config = mediaStoreConfig(process.env, process.cwd());
  if (!config.ok) throw new DomainError("MEDIA_STORAGE_UNAVAILABLE", config.problem);
  return config.store;
}
