import { Button } from "@mantine/core";
import type { PaperIdMapping } from "../citations/types";
import { formatPaperLabel } from "./citation-utils";

export interface PaperHeaderProps {
  paperId: string;
  rank: number;
  rankRationale: string;
  done: boolean;
  reviewed: number;
  total: number;
  onToggleDone(): void;
  paperIdMapping: PaperIdMapping;
  /** Disable the Mark-done toggle (e.g. while triage state is loading). */
  disabled?: boolean;
}

export function PaperHeader({
  paperId,
  rank,
  rankRationale,
  done,
  reviewed,
  total,
  onToggleDone,
  paperIdMapping,
  disabled = false,
}: PaperHeaderProps) {
  const entry = paperIdMapping.byAuthorYear[paperId];
  const doi = entry?.doi;
  const pmid = entry?.pmid;
  const externalHref = doi
    ? pmid
      ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}`
      : `https://doi.org/${doi}`
    : null;
  const label = doi ? formatPaperLabel(doi, pmid, paperIdMapping) : paperId;

  return (
    <div className="flex items-start justify-between border-b border-gray-200 px-4 py-2">
      <div className="min-w-0 flex-1 pr-2">
        <div className="text-sm font-semibold">
          #{rank} ·{" "}
          {externalHref ? (
            <a
              href={externalHref}
              target="_blank"
              rel="noopener noreferrer"
              className="text-cyan-700 hover:underline"
              data-testid="citation-paper-link"
            >
              {label}
            </a>
          ) : (
            paperId
          )}
        </div>
        {rankRationale && (
          <div
            className="mt-0.5 text-xs italic text-gray-500"
            data-testid="paper-rank-rationale"
          >
            {rankRationale}
          </div>
        )}
        <div className="mt-0.5 text-xs text-gray-600">
          {total} claim{total === 1 ? "" : "s"} · {reviewed} reviewed
        </div>
      </div>
      <Button
        size="xs"
        variant={done ? "light" : "filled"}
        onClick={onToggleDone}
        disabled={disabled}
        data-testid="mark-done-button"
      >
        {done ? "✓ Triage done · undo" : "Mark triage done →"}
      </Button>
    </div>
  );
}
