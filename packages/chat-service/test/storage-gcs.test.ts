import { beforeEach, describe, expect, test, vi } from "vitest";
import { Storage as GcsStorageClient } from "@google-cloud/storage";
import { createGcsStorage } from "../src/storage/gcs.js";
import { StorageConflictError } from "../src/storage/interface.js";

// Mock @google-cloud/storage so tests don't hit GCS or need credentials.
// The mocked Storage class has a per-instance `bucket = vi.fn()`; each
// test installs an implementation that returns a shared bucketRef whose
// `file(name)` and `getFiles(opts)` are configurable per-test.
vi.mock("@google-cloud/storage", () => {
  class MockStorage {
    bucket = vi.fn();
  }
  return { Storage: MockStorage };
});

function makeClient() {
  const file = {
    name: "",
    download: vi.fn(),
    save: vi.fn(),
    exists: vi.fn(),
  };
  const bucketRef = {
    file: vi.fn((name: string) => {
      file.name = name;
      return file;
    }),
    getFiles: vi.fn(),
  };
  const client = new GcsStorageClient();
  (client.bucket as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    () => bucketRef,
  );
  return { client, bucketRef, file };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// read / readText / readJson
// ---------------------------------------------------------------------------

describe("read", () => {
  test("calls bucket.file with prefix-joined key, returns buffer", async () => {
    const { client, bucketRef, file } = makeClient();
    file.download.mockResolvedValue([Buffer.from([1, 2, 3])]);
    const storage = createGcsStorage({ client, bucket: "b", prefix: "p/" });
    const result = await storage.read("k");
    expect(result).toEqual(Buffer.from([1, 2, 3]));
    expect(bucketRef.file).toHaveBeenCalledWith("p/k");
    expect(file.download).toHaveBeenCalledTimes(1);
  });

  test("returns null on 404", async () => {
    const { client, file } = makeClient();
    file.download.mockRejectedValue(
      Object.assign(new Error("not found"), { code: 404 }),
    );
    const storage = createGcsStorage({ client, bucket: "b" });
    expect(await storage.read("missing")).toBeNull();
  });

  test("propagates other errors", async () => {
    const { client, file } = makeClient();
    file.download.mockRejectedValue(new Error("transient"));
    const storage = createGcsStorage({ client, bucket: "b" });
    await expect(storage.read("k")).rejects.toThrow(/transient/);
  });

  test("readText decodes the body and returns the string", async () => {
    const { client, file } = makeClient();
    file.download.mockResolvedValue([Buffer.from("hello", "utf-8")]);
    const storage = createGcsStorage({ client, bucket: "b" });
    expect(await storage.readText("k")).toBe("hello");
  });

  test("readText returns null on 404", async () => {
    const { client, file } = makeClient();
    file.download.mockRejectedValue(
      Object.assign(new Error("not found"), { code: 404 }),
    );
    const storage = createGcsStorage({ client, bucket: "b" });
    expect(await storage.readText("k")).toBeNull();
  });

  test("readJson parses JSON", async () => {
    const { client, file } = makeClient();
    file.download.mockResolvedValue([
      Buffer.from('{"hello":"world"}', "utf-8"),
    ]);
    const storage = createGcsStorage({ client, bucket: "b" });
    expect(await storage.readJson("k")).toEqual({ hello: "world" });
  });

  test("readJson returns null on 404", async () => {
    const { client, file } = makeClient();
    file.download.mockRejectedValue(
      Object.assign(new Error("not found"), { code: 404 }),
    );
    const storage = createGcsStorage({ client, bucket: "b" });
    expect(await storage.readJson("k")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// write / writeJson
// ---------------------------------------------------------------------------

describe("write", () => {
  test("calls file.save with body and prefix-joined key", async () => {
    const { client, bucketRef, file } = makeClient();
    file.save.mockResolvedValue(undefined);
    const storage = createGcsStorage({ client, bucket: "b", prefix: "p/" });
    await storage.write("k", "payload");
    expect(bucketRef.file).toHaveBeenCalledWith("p/k");
    expect(file.save).toHaveBeenCalledWith("payload");
  });

  test("writeJson serialises and sets contentType", async () => {
    const { client, file } = makeClient();
    file.save.mockResolvedValue(undefined);
    const storage = createGcsStorage({ client, bucket: "b" });
    await storage.writeJson("k.json", { a: 1 });
    expect(file.save).toHaveBeenCalledWith('{"a":1}', {
      contentType: "application/json",
    });
  });
});

// ---------------------------------------------------------------------------
// writeIfAbsent
// ---------------------------------------------------------------------------

describe("writeIfAbsent", () => {
  test("passes ifGenerationMatch:0 to file.save", async () => {
    const { client, file } = makeClient();
    file.save.mockResolvedValue(undefined);
    const storage = createGcsStorage({ client, bucket: "b" });
    await storage.writeIfAbsent("k", "body");
    expect(file.save).toHaveBeenCalledWith("body", {
      preconditionOpts: { ifGenerationMatch: 0 },
    });
  });

  test("translates 412 PreconditionFailed to StorageConflictError", async () => {
    const { client, file } = makeClient();
    file.save.mockRejectedValue(
      Object.assign(new Error("precondition"), { code: 412 }),
    );
    const storage = createGcsStorage({ client, bucket: "b" });
    await expect(storage.writeIfAbsent("k", "body")).rejects.toBeInstanceOf(
      StorageConflictError,
    );
  });

  test("propagates non-412 errors", async () => {
    const { client, file } = makeClient();
    file.save.mockRejectedValue(
      Object.assign(new Error("blew up"), { code: 500 }),
    );
    const storage = createGcsStorage({ client, bucket: "b" });
    await expect(storage.writeIfAbsent("k", "body")).rejects.toThrow(/blew up/);
  });
});

// ---------------------------------------------------------------------------
// exists
// ---------------------------------------------------------------------------

describe("exists", () => {
  test("returns true when file.exists() returns [true]", async () => {
    const { client, file } = makeClient();
    file.exists.mockResolvedValue([true]);
    const storage = createGcsStorage({ client, bucket: "b" });
    expect(await storage.exists("k")).toBe(true);
  });

  test("returns false when file.exists() returns [false]", async () => {
    const { client, file } = makeClient();
    file.exists.mockResolvedValue([false]);
    const storage = createGcsStorage({ client, bucket: "b" });
    expect(await storage.exists("k")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  test("issues getFiles with prefix-joined prefix; strips storage prefix from result names", async () => {
    const { client, bucketRef } = makeClient();
    bucketRef.getFiles.mockResolvedValue([
      [{ name: "p/a/one" }, { name: "p/a/two" }],
    ]);
    const storage = createGcsStorage({ client, bucket: "b", prefix: "p/" });
    const result = await storage.list("a/");
    expect(result).toEqual(["a/one", "a/two"]);
    expect(bucketRef.getFiles).toHaveBeenCalledWith({ prefix: "p/a/" });
  });

  test("empty file list returns empty list", async () => {
    const { client, bucketRef } = makeClient();
    bucketRef.getFiles.mockResolvedValue([[]]);
    const storage = createGcsStorage({ client, bucket: "b" });
    expect(await storage.list("nothing/")).toEqual([]);
  });

  test("results are sorted alphabetically (parity with s3 backend)", async () => {
    const { client, bucketRef } = makeClient();
    bucketRef.getFiles.mockResolvedValue([
      [{ name: "c" }, { name: "a" }, { name: "b" }],
    ]);
    const storage = createGcsStorage({ client, bucket: "b" });
    expect(await storage.list("")).toEqual(["a", "b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// Env-driven factory
// ---------------------------------------------------------------------------

describe("env-driven factory", () => {
  test("returns a Storage with the configured prefix when no `client` is passed", () => {
    const storage = createGcsStorage({ bucket: "b", prefix: "scoped/" });
    expect(storage.prefix).toBe("scoped/");
    expect(typeof storage.read).toBe("function");
    expect(typeof storage.write).toBe("function");
    expect(typeof storage.writeIfAbsent).toBe("function");
    expect(typeof storage.list).toBe("function");
  });

  test("defaults prefix to empty string when not supplied", () => {
    const storage = createGcsStorage({ bucket: "b" });
    expect(storage.prefix).toBe("");
  });
});
