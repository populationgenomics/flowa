/**
 * Thin storage abstraction. Five operations cover everything chat-service
 * needs: read / write / writeIfAbsent / exists / list. Different backends
 * (local FS, S3-compatible) implement the same surface; chat-service code
 * never reaches past this.
 *
 * `writeIfAbsent` is atomic create-only — required by the edit-draft
 * version-increment-on-collision loop in `storage-keys.ts`. Each backend
 * implements it with its native primitive (POSIX `O_CREAT|O_EXCL`,
 * S3 `IfNoneMatch: '*'`).
 */
export interface Storage {
  /** Optional prefix prepended to every key. */
  readonly prefix: string;

  read(key: string): Promise<Buffer | null>;
  readText(key: string): Promise<string | null>;
  readJson<T>(key: string): Promise<T | null>;

  write(key: string, body: Buffer | string): Promise<void>;
  writeJson(key: string, value: unknown): Promise<void>;

  /** Atomic create-only write. Throws `StorageConflictError` on collision. */
  writeIfAbsent(key: string, body: Buffer | string): Promise<void>;

  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}

/**
 * Thrown by `Storage.writeIfAbsent` when an object already exists at the
 * target key. Callers (e.g. `writeEditDraft`) catch this and retry with an
 * incremented version number.
 */
export class StorageConflictError extends Error {
  constructor(key: string) {
    super(`Object already exists at key: ${key}`);
    this.name = "StorageConflictError";
  }
}
