import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createS3Storage } from "../src/storage/s3.js";
import { StorageConflictError } from "../src/storage/interface.js";

// Mock the AWS SDK so tests don't need real credentials or network. The mock
// commands capture their constructor input verbatim, mirroring the real
// commands' shape; the mock S3Client provides a `vi.fn()` send we drive
// per-test.
vi.mock("@aws-sdk/client-s3", () => {
  class MockGetObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockPutObjectCommand {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockListObjectsV2Command {
    input: unknown;
    constructor(input: unknown) {
      this.input = input;
    }
  }
  class MockS3Client {
    config: unknown;
    send = vi.fn();
    constructor(config?: unknown) {
      this.config = config;
    }
  }
  return {
    S3Client: MockS3Client,
    GetObjectCommand: MockGetObjectCommand,
    PutObjectCommand: MockPutObjectCommand,
    ListObjectsV2Command: MockListObjectsV2Command,
  };
});

type MockSend = ReturnType<typeof vi.fn>;

function makeClient(): { client: S3Client; send: MockSend } {
  const client = new S3Client();
  return { client, send: client.send as unknown as MockSend };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// read / readText / readJson
// ---------------------------------------------------------------------------

describe("read", () => {
  test("issues GetObjectCommand with prefix-joined key, returns buffer", async () => {
    const { client, send } = makeClient();
    send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });
    const storage = createS3Storage({ client, bucket: "b", prefix: "p/" });
    const result = await storage.read("k");
    expect(result).toEqual(Buffer.from([1, 2, 3]));
    expect(send).toHaveBeenCalledTimes(1);
    const cmd = send.mock.calls[0]?.[0];
    expect(cmd).toBeInstanceOf(GetObjectCommand);
    expect(cmd.input).toEqual({ Bucket: "b", Key: "p/k" });
  });

  test("returns null on NoSuchKey", async () => {
    const { client, send } = makeClient();
    send.mockRejectedValue(
      Object.assign(new Error("nope"), { name: "NoSuchKey" }),
    );
    const storage = createS3Storage({ client, bucket: "b" });
    expect(await storage.read("missing")).toBeNull();
  });

  test("propagates other errors", async () => {
    const { client, send } = makeClient();
    send.mockRejectedValue(new Error("transient"));
    const storage = createS3Storage({ client, bucket: "b" });
    await expect(storage.read("k")).rejects.toThrow(/transient/);
  });

  test("readText decodes the body and returns the string", async () => {
    const { client, send } = makeClient();
    send.mockResolvedValue({
      Body: { transformToString: async () => "hello" },
    });
    const storage = createS3Storage({ client, bucket: "b" });
    expect(await storage.readText("k")).toBe("hello");
  });

  test("readText returns null on NoSuchKey", async () => {
    const { client, send } = makeClient();
    send.mockRejectedValue(
      Object.assign(new Error("nope"), { name: "NoSuchKey" }),
    );
    const storage = createS3Storage({ client, bucket: "b" });
    expect(await storage.readText("k")).toBeNull();
  });

  test("readJson parses JSON", async () => {
    const { client, send } = makeClient();
    send.mockResolvedValue({
      Body: { transformToString: async () => '{"hello":"world"}' },
    });
    const storage = createS3Storage({ client, bucket: "b" });
    expect(await storage.readJson("k")).toEqual({ hello: "world" });
  });

  test("readJson returns null on NoSuchKey", async () => {
    const { client, send } = makeClient();
    send.mockRejectedValue(
      Object.assign(new Error("nope"), { name: "NoSuchKey" }),
    );
    const storage = createS3Storage({ client, bucket: "b" });
    expect(await storage.readJson("k")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// write / writeJson
// ---------------------------------------------------------------------------

describe("write", () => {
  test("issues PutObjectCommand with prefix-joined key and body", async () => {
    const { client, send } = makeClient();
    send.mockResolvedValue({});
    const storage = createS3Storage({ client, bucket: "b", prefix: "p/" });
    await storage.write("k", "payload");
    const cmd = send.mock.calls[0]?.[0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toEqual({ Bucket: "b", Key: "p/k", Body: "payload" });
  });

  test("writeJson serialises and sets ContentType", async () => {
    const { client, send } = makeClient();
    send.mockResolvedValue({});
    const storage = createS3Storage({ client, bucket: "b" });
    await storage.writeJson("k.json", { a: 1 });
    const cmd = send.mock.calls[0]?.[0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toEqual({
      Bucket: "b",
      Key: "k.json",
      Body: '{"a":1}',
      ContentType: "application/json",
    });
  });
});

// ---------------------------------------------------------------------------
// writeIfAbsent
// ---------------------------------------------------------------------------

describe("writeIfAbsent", () => {
  test("sets IfNoneMatch:'*' on the PutObjectCommand", async () => {
    const { client, send } = makeClient();
    send.mockResolvedValue({});
    const storage = createS3Storage({ client, bucket: "b" });
    await storage.writeIfAbsent("k", "body");
    const cmd = send.mock.calls[0]?.[0];
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toEqual({
      Bucket: "b",
      Key: "k",
      Body: "body",
      IfNoneMatch: "*",
    });
  });

  test("translates 412 PreconditionFailed to StorageConflictError", async () => {
    const { client, send } = makeClient();
    send.mockRejectedValue(
      Object.assign(new Error("precondition"), {
        $metadata: { httpStatusCode: 412 },
      }),
    );
    const storage = createS3Storage({ client, bucket: "b" });
    await expect(storage.writeIfAbsent("k", "body")).rejects.toBeInstanceOf(
      StorageConflictError,
    );
  });

  test("propagates non-412 errors", async () => {
    const { client, send } = makeClient();
    send.mockRejectedValue(
      Object.assign(new Error("blew up"), {
        $metadata: { httpStatusCode: 500 },
      }),
    );
    const storage = createS3Storage({ client, bucket: "b" });
    await expect(storage.writeIfAbsent("k", "body")).rejects.toThrow(/blew up/);
  });
});

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

describe("exists", () => {
  test("returns true when read returns content", async () => {
    const { client, send } = makeClient();
    send.mockResolvedValue({
      Body: { transformToByteArray: async () => new Uint8Array([0]) },
    });
    const storage = createS3Storage({ client, bucket: "b" });
    expect(await storage.exists("k")).toBe(true);
  });

  test("returns false when read returns null (NoSuchKey)", async () => {
    const { client, send } = makeClient();
    send.mockRejectedValue(
      Object.assign(new Error("nope"), { name: "NoSuchKey" }),
    );
    const storage = createS3Storage({ client, bucket: "b" });
    expect(await storage.exists("k")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list (with pagination)
// ---------------------------------------------------------------------------

describe("list", () => {
  test("issues ListObjectsV2Command with prefix-joined prefix and strips prefix from result keys", async () => {
    const { client, send } = makeClient();
    send.mockResolvedValue({
      Contents: [{ Key: "p/a/one" }, { Key: "p/a/two" }],
    });
    const storage = createS3Storage({ client, bucket: "b", prefix: "p/" });
    const result = await storage.list("a/");
    expect(result).toEqual(["a/one", "a/two"]);
    const cmd = send.mock.calls[0]?.[0];
    expect(cmd).toBeInstanceOf(ListObjectsV2Command);
    expect(cmd.input).toEqual({
      Bucket: "b",
      Prefix: "p/a/",
      ContinuationToken: undefined,
    });
  });

  test("paginates through ContinuationToken", async () => {
    const { client, send } = makeClient();
    send
      .mockResolvedValueOnce({
        Contents: [{ Key: "a/1" }, { Key: "a/2" }],
        IsTruncated: true,
        NextContinuationToken: "tok-1",
      })
      .mockResolvedValueOnce({
        Contents: [{ Key: "a/3" }],
        IsTruncated: false,
      });
    const storage = createS3Storage({ client, bucket: "b" });
    const result = await storage.list("a/");
    expect(result).toEqual(["a/1", "a/2", "a/3"]);
    expect(send).toHaveBeenCalledTimes(2);
    const second = send.mock.calls[1]?.[0];
    expect(second.input.ContinuationToken).toBe("tok-1");
  });

  test("empty Contents returns empty list", async () => {
    const { client, send } = makeClient();
    send.mockResolvedValue({});
    const storage = createS3Storage({ client, bucket: "b" });
    expect(await storage.list("nothing/")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Env-driven factory
// ---------------------------------------------------------------------------

describe("env-driven factory", () => {
  test("returns a Storage with the configured prefix when no `client` is passed", () => {
    const storage = createS3Storage({ bucket: "b", prefix: "scoped/" });
    expect(storage.prefix).toBe("scoped/");
    expect(typeof storage.read).toBe("function");
    expect(typeof storage.write).toBe("function");
    expect(typeof storage.writeIfAbsent).toBe("function");
    expect(typeof storage.list).toBe("function");
  });

  test("defaults prefix to empty string when not supplied", () => {
    const storage = createS3Storage({ bucket: "b" });
    expect(storage.prefix).toBe("");
  });
});
