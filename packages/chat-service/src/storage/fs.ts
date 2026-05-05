import {
  open,
  readFile,
  writeFile,
  mkdir,
  stat,
  readdir,
} from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { type Storage, StorageConflictError } from "./interface.js";

export interface FsStorageOptions {
  /** Absolute root directory for all keys. Created on first write if missing. */
  root: string;
  /** Optional prefix prepended to every key (joined as a path segment). */
  prefix?: string;
}

/**
 * Local filesystem `Storage` backend. Atomic create-only via
 * `O_CREAT|O_EXCL`. Concurrent calls to `writeIfAbsent` for the same key
 * deterministically pick one winner; the loser sees `StorageConflictError`.
 */
export function createFsStorage(options: FsStorageOptions): Storage {
  const root = resolve(options.root);
  const prefix = options.prefix ?? "";

  function pathFor(key: string): string {
    const full = join(root, prefix, key);
    const resolved = resolve(full);
    // Reject path-traversal attempts (key="../.." etc.).
    if (!resolved.startsWith(root + sep) && resolved !== root) {
      throw new Error(`Path traversal rejected for key: ${key}`);
    }
    return resolved;
  }

  return {
    prefix,

    async read(key) {
      try {
        return await readFile(pathFor(key));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },

    async readText(key) {
      const buf = await this.read(key);
      return buf ? buf.toString("utf-8") : null;
    },

    async readJson<T>(key: string) {
      const text = await this.readText(key);
      return text ? (JSON.parse(text) as T) : null;
    },

    async write(key, body) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, body);
    },

    async writeJson(key, value) {
      await this.write(key, JSON.stringify(value));
    },

    async writeIfAbsent(key, body) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      let handle;
      try {
        // O_CREAT|O_EXCL: create only if not exists; EEXIST otherwise.
        handle = await open(path, "wx");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new StorageConflictError(key);
        }
        throw error;
      }
      try {
        await handle.writeFile(body);
      } finally {
        await handle.close();
      }
    },

    async exists(key) {
      try {
        await stat(pathFor(key));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },

    async list(listPrefix) {
      const base = pathFor(listPrefix);
      const baseRoot = pathFor("");
      const out: string[] = [];
      async function walk(dir: string): Promise<void> {
        let entries;
        try {
          entries = await readdir(dir, { withFileTypes: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
          throw error;
        }
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            await walk(full);
          } else if (entry.isFile()) {
            // Return keys relative to the configured root (so list output is
            // symmetric with read/write keys).
            const rel = full
              .slice(baseRoot.length)
              .replace(/^[/\\]/, "")
              .replaceAll(sep, "/");
            out.push(rel);
          }
        }
      }
      await walk(base);
      return out.sort();
    },
  };
}
