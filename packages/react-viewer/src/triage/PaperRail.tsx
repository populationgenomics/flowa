import { Badge, Text } from "@mantine/core";
import type { PaperIdMapping } from "../citations/types";
import type { Claim, RankedPaper, TriageStateValue } from "./types";
import { claimKey } from "./store";

export interface PaperRailProps {
  papers: RankedPaper[];
  claimsByPaper: Map<string, Claim[]>;
  claimStates: Record<string, TriageStateValue>;
  papersDone: Record<string, { triageDoneAt: Date; triageDoneBy: string }>;
  focusedPaperId: string | null;
  onFocusPaper(paperId: string): void;
  /**
   * Resolves a paper's cite key to its identifiers. When given, each row
   * shows the PubMed id, or the DOI for a paper without one, under the cite
   * key, so the identifier can be read off the rail without focusing the
   * paper.
   */
  paperIdMapping?: PaperIdMapping;
}

/** "PMID 12345678" when the paper has one, else its DOI, else nothing. */
function identifierLabel(
  paperId: string,
  mapping: PaperIdMapping | undefined,
): string | null {
  const entry = mapping?.byAuthorYear[paperId];
  if (!entry) return null;
  return entry.pmid ? `PMID ${entry.pmid}` : entry.doi;
}

export function PaperRail({
  papers,
  claimsByPaper,
  claimStates,
  papersDone,
  focusedPaperId,
  onFocusPaper,
  paperIdMapping,
}: PaperRailProps) {
  return (
    <div
      className="flex w-48 shrink-0 flex-col border-r border-gray-200 bg-gray-50 p-2"
      data-testid="paper-rail"
    >
      <div className="mb-2">
        <Text size="xs" fw={700} c="dimmed">
          PAPERS
        </Text>
      </div>
      <div className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {papers.map((paper, i) => {
          const group = claimsByPaper.get(paper.paperId) ?? [];
          const decidedCount = group.reduce((sum, _, idx) => {
            const s =
              claimStates[claimKey(paper.paperId, idx + 1)] ?? "UNREVIEWED";
            return s === "UNREVIEWED" ? sum : sum + 1;
          }, 0);
          const acceptedHere = group.reduce((sum, _, idx) => {
            const s =
              claimStates[claimKey(paper.paperId, idx + 1)] ?? "UNREVIEWED";
            return s === "ACCEPTED" ? sum + 1 : sum;
          }, 0);
          const rejectedHere = group.reduce((sum, _, idx) => {
            const s =
              claimStates[claimKey(paper.paperId, idx + 1)] ?? "UNREVIEWED";
            return s === "REJECTED" ? sum + 1 : sum;
          }, 0);
          const done = papersDone[paper.paperId] != null;
          const isFocused = paper.paperId === focusedPaperId;
          const identifier = identifierLabel(paper.paperId, paperIdMapping);
          return (
            <button
              key={paper.paperId}
              onClick={() => onFocusPaper(paper.paperId)}
              data-testid={`paper-row-${paper.paperId}`}
              className={`rounded px-2 py-1 text-left text-sm ${
                isFocused
                  ? "border-l-4 border-blue-500 bg-white"
                  : "hover:bg-gray-100"
              }`}
            >
              <div className="font-medium">
                #{i + 1} {paper.paperId}
              </div>
              {identifier && (
                <div
                  className="truncate text-[11px] text-gray-500"
                  title={identifier}
                  data-testid={`paper-id-${paper.paperId}`}
                >
                  {identifier}
                </div>
              )}
              <div className="text-xs text-gray-600">
                {decidedCount}/{group.length}
                {acceptedHere > 0 && ` ✓${acceptedHere}`}
                {rejectedHere > 0 && ` ✗${rejectedHere}`}
                {done && (
                  <Badge color="green" size="xs" ml={4}>
                    ✓ done
                  </Badge>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
