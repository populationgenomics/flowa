import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { type Storage, StorageConflictError } from "./interface.js";

/**
 * Env-driven form: chat-service constructs the S3 client using the AWS
 * SDK's default credential chain (`fromNodeProviderChain`). For S3-compat
 * providers other than AWS (Cloudflare R2, Backblaze B2, MinIO,
 * DigitalOcean Spaces, Wasabi, Hetzner, etc.), set `endpoint` and any
 * required `forcePathStyle`.
 */
export interface S3StorageConfigOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  /** Extra `S3ClientConfig` merged on top of the values above. */
  clientConfig?: S3ClientConfig;
}

/**
 * Programmatic form: caller hands in a pre-built `S3Client`. Use this
 * when the deployment needs custom credential minting (OIDC->STS, etc.)
 * that the default chain does not cover.
 */
export interface S3StorageClientOptions {
  client: S3Client;
  bucket: string;
  prefix?: string;
}

export function createS3Storage(
  options: S3StorageConfigOptions | S3StorageClientOptions,
): Storage {
  if ("client" in options) {
    return makeStorage({
      client: options.client,
      bucket: options.bucket,
      prefix: options.prefix ?? "",
    });
  }
  const client = new S3Client({
    region: options.region ?? "us-east-1",
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.forcePathStyle ? { forcePathStyle: true } : {}),
    ...options.clientConfig,
  });
  return makeStorage({
    client,
    bucket: options.bucket,
    prefix: options.prefix ?? "",
  });
}

interface MakeStorageArgs {
  client: S3Client;
  bucket: string;
  prefix: string;
}

function makeStorage({ client, bucket, prefix }: MakeStorageArgs): Storage {
  function fullKey(key: string): string {
    return prefix + key;
  }

  return {
    prefix,

    async read(key) {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: fullKey(key) }),
        );
        const bytes = await response.Body?.transformToByteArray();
        return bytes ? Buffer.from(bytes) : null;
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return null;
        throw error;
      }
    },

    async readText(key) {
      try {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: fullKey(key) }),
        );
        return (await response.Body?.transformToString()) ?? null;
      } catch (error) {
        if ((error as { name?: string }).name === "NoSuchKey") return null;
        throw error;
      }
    },

    async readJson<T>(key: string) {
      const text = await this.readText(key);
      return text ? (JSON.parse(text) as T) : null;
    },

    async write(key, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fullKey(key),
          Body: body,
        }),
      );
    },

    async writeJson(key, value) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: fullKey(key),
          Body: JSON.stringify(value),
          ContentType: "application/json",
        }),
      );
    },

    async writeIfAbsent(key, body) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: fullKey(key),
            Body: body,
            IfNoneMatch: "*",
          }),
        );
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode;
        if (status === 412) {
          throw new StorageConflictError(key);
        }
        throw error;
      }
    },

    async exists(key) {
      const buf = await this.read(key);
      return buf !== null;
    },

    async list(listPrefix) {
      const out: string[] = [];
      let continuationToken: string | undefined;
      do {
        const response = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: fullKey(listPrefix),
            ContinuationToken: continuationToken,
          }),
        );
        for (const obj of response.Contents ?? []) {
          if (obj.Key) {
            out.push(obj.Key.slice(prefix.length));
          }
        }
        continuationToken = response.IsTruncated
          ? response.NextContinuationToken
          : undefined;
      } while (continuationToken);
      return out.sort();
    },
  };
}
