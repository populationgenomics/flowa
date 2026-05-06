import { Storage as GcsStorageClient } from "@google-cloud/storage";
import { type Storage, StorageConflictError } from "./interface.js";

/**
 * Env-driven form: chat-service constructs the GCS client with no
 * explicit config; the SDK resolves credentials from Application Default
 * Credentials (`GOOGLE_APPLICATION_CREDENTIALS`, gcloud user creds, GCE
 * metadata server, etc.). For deployments needing custom client config
 * (custom endpoint for emulators, programmatic credential injection,
 * etc.), use the `{ client }` programmatic form below.
 */
export interface GcsStorageConfigOptions {
  bucket: string;
  prefix?: string;
}

/**
 * Programmatic form: caller hands in a pre-built GCS `Storage` client.
 * Use this when the deployment needs custom credential minting (Workload
 * Identity Federation, custom token exchange, etc.) that the default
 * chain does not cover.
 */
export interface GcsStorageClientOptions {
  client: GcsStorageClient;
  bucket: string;
  prefix?: string;
}

export function createGcsStorage(
  options: GcsStorageConfigOptions | GcsStorageClientOptions,
): Storage {
  if ("client" in options) {
    return makeStorage({
      client: options.client,
      bucket: options.bucket,
      prefix: options.prefix ?? "",
    });
  }
  return makeStorage({
    client: new GcsStorageClient(),
    bucket: options.bucket,
    prefix: options.prefix ?? "",
  });
}

interface MakeStorageArgs {
  client: GcsStorageClient;
  bucket: string;
  prefix: string;
}

function makeStorage({ client, bucket, prefix }: MakeStorageArgs): Storage {
  const bucketRef = client.bucket(bucket);

  function fullKey(key: string): string {
    return prefix + key;
  }

  return {
    prefix,

    async read(key) {
      try {
        const [buffer] = await bucketRef.file(fullKey(key)).download();
        return buffer;
      } catch (error) {
        if ((error as { code?: number }).code === 404) return null;
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
      await bucketRef.file(fullKey(key)).save(body);
    },

    async writeJson(key, value) {
      await bucketRef.file(fullKey(key)).save(JSON.stringify(value), {
        contentType: "application/json",
      });
    },

    async writeIfAbsent(key, body) {
      try {
        // ifGenerationMatch:0 means "object must not exist"; on collision GCS
        // returns 412 PreconditionFailed, which we translate below.
        await bucketRef.file(fullKey(key)).save(body, {
          preconditionOpts: { ifGenerationMatch: 0 },
        });
      } catch (error) {
        if ((error as { code?: number }).code === 412) {
          throw new StorageConflictError(key);
        }
        throw error;
      }
    },

    async exists(key) {
      const [exists] = await bucketRef.file(fullKey(key)).exists();
      return exists;
    },

    async list(listPrefix) {
      // bucket.getFiles auto-paginates: for buckets > 1000 objects the SDK
      // transparently issues subsequent pageToken requests internally and
      // returns the accumulated list as a single-element tuple.
      const [files] = await bucketRef.getFiles({
        prefix: fullKey(listPrefix),
      });
      return files.map((f) => f.name.slice(prefix.length)).sort();
    },
  };
}
