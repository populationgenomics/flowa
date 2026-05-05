import { readFileSync } from "node:fs";
import { join } from "node:path";

const cache = new Map<string, string>();

/**
 * Load `aggregate_edit_prompt.txt` from `promptDir`. Cached per directory
 * for the process lifetime; the file is small and rarely changes between
 * deploys.
 */
export function loadEditPromptTemplate(promptDir: string): string {
  let cached = cache.get(promptDir);
  if (!cached) {
    cached = readFileSync(
      join(promptDir, "aggregate_edit_prompt.txt"),
      "utf-8",
    );
    cache.set(promptDir, cached);
  }
  return cached;
}
