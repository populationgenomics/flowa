import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFsStorage } from "../src/storage/fs.js";
import { StorageConflictError } from "../src/storage/interface.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "flowa-chat-fs-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Round-trip read / write
// ---------------------------------------------------------------------------

describe("read/write round-trip", () => {
  test("write + read returns the same buffer", async () => {
    const storage = createFsStorage({ root });
    await storage.write("a/b/c.bin", Buffer.from([1, 2, 3]));
    const out = await storage.read("a/b/c.bin");
    expect(out).toEqual(Buffer.from([1, 2, 3]));
  });

  test("write + readText returns the same string", async () => {
    const storage = createFsStorage({ root });
    await storage.write("hello.txt", "hello, world");
    expect(await storage.readText("hello.txt")).toBe("hello, world");
  });

  test("writeJson + readJson round-trips structure", async () => {
    const storage = createFsStorage({ root });
    const value = { name: "flowa", count: 42, nested: { ok: true } };
    await storage.writeJson("data.json", value);
    expect(await storage.readJson("data.json")).toEqual(value);
  });

  test("read returns null for missing keys", async () => {
    const storage = createFsStorage({ root });
    expect(await storage.read("missing.bin")).toBeNull();
    expect(await storage.readText("missing.txt")).toBeNull();
    expect(await storage.readJson("missing.json")).toBeNull();
  });

  test("write creates intermediate directories", async () => {
    const storage = createFsStorage({ root });
    await storage.write("deeply/nested/path/file.txt", "ok");
    expect(
      await readFile(join(root, "deeply/nested/path/file.txt"), "utf-8"),
    ).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// exists / list
// ---------------------------------------------------------------------------

describe("exists + list", () => {
  test("exists returns true after write, false before", async () => {
    const storage = createFsStorage({ root });
    expect(await storage.exists("k.txt")).toBe(false);
    await storage.write("k.txt", "x");
    expect(await storage.exists("k.txt")).toBe(true);
  });

  test("list returns keys relative to the configured root", async () => {
    const storage = createFsStorage({ root });
    await storage.write("a/one.txt", "1");
    await storage.write("a/two.txt", "2");
    await storage.write("b/three.txt", "3");
    expect(await storage.list("a")).toEqual(["a/one.txt", "a/two.txt"]);
  });

  test("list returns empty for missing prefix without throwing", async () => {
    const storage = createFsStorage({ root });
    expect(await storage.list("does-not-exist")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// writeIfAbsent atomicity
// ---------------------------------------------------------------------------

describe("writeIfAbsent atomicity", () => {
  test("succeeds on first call", async () => {
    const storage = createFsStorage({ root });
    await storage.writeIfAbsent("once.txt", "first");
    expect(await storage.readText("once.txt")).toBe("first");
  });

  test("throws StorageConflictError on collision", async () => {
    const storage = createFsStorage({ root });
    await storage.writeIfAbsent("clash.txt", "first");
    await expect(
      storage.writeIfAbsent("clash.txt", "second"),
    ).rejects.toBeInstanceOf(StorageConflictError);
    // The conflicting write must not have overwritten the original.
    expect(await storage.readText("clash.txt")).toBe("first");
  });

  test("concurrent writeIfAbsent: exactly one winner", async () => {
    const storage = createFsStorage({ root });
    const results = await Promise.allSettled([
      storage.writeIfAbsent("race.txt", "A"),
      storage.writeIfAbsent("race.txt", "B"),
      storage.writeIfAbsent("race.txt", "C"),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        StorageConflictError,
      );
    }
    const winner = await storage.readText("race.txt");
    expect(["A", "B", "C"]).toContain(winner);
  });
});

// ---------------------------------------------------------------------------
// Prefix
// ---------------------------------------------------------------------------

describe("prefix", () => {
  test("prefix is joined into paths and surfaced on the storage object", async () => {
    const storage = createFsStorage({ root, prefix: "scoped" });
    expect(storage.prefix).toBe("scoped");
    await storage.write("a.txt", "x");
    // Verify file actually landed under the prefix directory.
    expect(await readFile(join(root, "scoped", "a.txt"), "utf-8")).toBe("x");
    // And reads round-trip with the same key.
    expect(await storage.readText("a.txt")).toBe("x");
  });
});

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

describe("path traversal", () => {
  test("rejects keys that escape the configured root", async () => {
    const storage = createFsStorage({ root });
    await expect(storage.write("../escape.txt", "nope")).rejects.toThrow(
      /Path traversal/,
    );
    await expect(storage.read("../escape.txt")).rejects.toThrow(
      /Path traversal/,
    );
  });
});
