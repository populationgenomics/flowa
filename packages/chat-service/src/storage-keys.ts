import { type Storage, StorageConflictError } from "./storage/interface.js";

/** Percent-encode a DOI for storage keys (matches Python's urllib.parse.quote(doi, safe='')). */
export function encodeDoi(doi: string): string {
  return encodeURIComponent(doi).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export async function loadQueryResult(
  storage: Storage,
  variantId: string,
): Promise<{ dois: string[] } | null> {
  return storage.readJson<{ dois: string[] }>(
    `assessments/${variantId}/query.json`,
  );
}

export async function loadAggregate(
  storage: Storage,
  variantId: string,
): Promise<unknown> {
  return storage.readJson(`assessments/${variantId}/aggregation.json`);
}

export async function loadExtraction(
  storage: Storage,
  variantId: string,
  doi: string,
): Promise<unknown> {
  return storage.readJson(
    `assessments/${variantId}/extractions/${encodeDoi(doi)}.json`,
  );
}

export async function loadMarkdown(
  storage: Storage,
  doi: string,
): Promise<string | null> {
  return storage.readText(`papers/${encodeDoi(doi)}/markdown.md`);
}

export async function loadPaperMetadata(
  storage: Storage,
  doi: string,
): Promise<Record<string, unknown> | null> {
  return storage.readJson(`papers/${encodeDoi(doi)}/metadata.json`);
}

// ---------------------------------------------------------------------------
// Audit log keys
// ---------------------------------------------------------------------------

export function auditLogKey(variantId: string, sessionId: string): string {
  return `chat-sessions/${variantId}/${sessionId}.json`;
}

// ---------------------------------------------------------------------------
// Edit drafts
// ---------------------------------------------------------------------------

/**
 * An edit draft as it lives in storage: the bare artifact JSON, plus its
 * version number parsed from the object key.
 */
export interface EditDraft {
  version: number;
  /** The artifact JSON body as written, verbatim. */
  artifactText: string;
}

function editDraftPrefix(variantId: string, category: string): string {
  return `edit-drafts/${variantId}/${category}/artifact-v`;
}

/**
 * List all edit draft versions for a (variant, category), sorted by version
 * number ascending. Returns empty array if no drafts exist.
 */
export async function listEditDrafts(
  storage: Storage,
  variantId: string,
  category: string,
): Promise<EditDraft[]> {
  const prefix = editDraftPrefix(variantId, category);
  const keys = (await storage.list(prefix))
    .filter((k) => k.startsWith(prefix) && k.endsWith(".json"))
    .sort((a, b) => {
      const vA = parseInt(a.slice(prefix.length, -5), 10);
      const vB = parseInt(b.slice(prefix.length, -5), 10);
      return vA - vB;
    });

  const drafts = await Promise.all(
    keys.map(async (key) => {
      const artifactText = await storage.readText(key);
      if (artifactText === null) return null;
      const version = parseInt(key.slice(prefix.length, -5), 10);
      return { version, artifactText };
    }),
  );
  return drafts.filter((d): d is EditDraft => d !== null);
}

/**
 * Write an edit draft version with atomic create-only semantics. If the
 * target version key already exists (concurrent writer beat us), increment
 * the version and retry up to `maxRetries` times. The returned version may
 * therefore be higher than `intendedVersion`.
 */
export async function writeEditDraft(
  storage: Storage,
  variantId: string,
  category: string,
  artifactText: string,
  intendedVersion: number,
  maxRetries = 3,
): Promise<number> {
  let version = intendedVersion;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const key = `${editDraftPrefix(variantId, category)}${version}.json`;
    try {
      await storage.writeIfAbsent(key, artifactText);
      return version;
    } catch (error) {
      if (error instanceof StorageConflictError && attempt < maxRetries) {
        version++;
        continue;
      }
      throw error;
    }
  }
  throw new Error(
    `Failed to write edit draft after ${maxRetries + 1} attempts`,
  );
}
