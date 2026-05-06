import type { Storage } from "./interface.js";

/**
 * Discriminated config for the env-driven default `index.ts`. Each backend
 * lives in its own module so the matching SDK (`@aws-sdk/client-s3` for
 * `s3`, `@google-cloud/storage` for `gcs`) is loaded only when actually
 * selected.
 */
export type StorageConfig =
  | { backend: "fs"; root: string; prefix?: string }
  | { backend: "s3"; bucket: string; prefix?: string }
  | { backend: "gcs"; bucket: string; prefix?: string };

/**
 * Construct a `Storage` from a typed config. The matching backend module is
 * dynamic-imported, so a deployment that only uses `fs` never loads
 * `@aws-sdk/client-s3`. If the peer SDK is missing at runtime, the
 * dynamic import fails with a clear error naming the unresolvable package.
 */
export async function createStorage(config: StorageConfig): Promise<Storage> {
  if (config.backend === "fs") {
    const { createFsStorage } = await import("./fs.js");
    return createFsStorage({
      root: config.root,
      ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
    });
  }
  if (config.backend === "s3") {
    const { createS3Storage } = await import("./s3.js");
    return createS3Storage({
      bucket: config.bucket,
      ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
    });
  }
  if (config.backend === "gcs") {
    const { createGcsStorage } = await import("./gcs.js");
    return createGcsStorage({
      bucket: config.bucket,
      ...(config.prefix !== undefined ? { prefix: config.prefix } : {}),
    });
  }
  // Exhaustiveness check — the discriminated union should cover every backend.
  const _exhaustive: never = config;
  throw new Error(
    `Unsupported storage backend: ${JSON.stringify(_exhaustive)}`,
  );
}
