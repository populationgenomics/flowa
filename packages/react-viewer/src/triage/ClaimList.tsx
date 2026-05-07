import { useState } from "react";
import { Button, Text } from "@mantine/core";
import type { Claim, TriageStateValue } from "./types";
import { claimKey } from "./store";

export interface ClaimListProps {
  paperId: string;
  claims: Claim[];
  focusedClaimIndex: number;
  claimStates: Record<string, TriageStateValue>;
  onFocus(claimIndex: number): void;
}

export function ClaimList({
  paperId,
  claims,
  focusedClaimIndex,
  claimStates,
  onFocus,
}: ClaimListProps) {
  const [expanded, setExpanded] = useState(false);
  if (claims.length <= 1) return null;
  const visibleCount = expanded ? claims.length : Math.min(4, claims.length);

  return (
    <div className="mt-3">
      <Text size="xs" fw={600} c="dimmed">
        Other claims in this paper
      </Text>
      <div className="mt-1 flex flex-col gap-1">
        {claims.slice(0, visibleCount).map((claim, i) => {
          const idx = i + 1;
          if (idx === focusedClaimIndex) return null;
          const state = claimStates[claimKey(paperId, idx)] ?? "UNREVIEWED";
          const icon =
            state === "ACCEPTED" ? "✓" : state === "REJECTED" ? "✗" : "☐";
          const cls =
            state === "ACCEPTED"
              ? "text-green-700"
              : state === "REJECTED"
                ? "text-red-700 line-through"
                : "text-gray-700";
          return (
            <button
              key={idx}
              onClick={() => onFocus(idx)}
              data-testid={`claim-list-item-${idx}`}
              data-state={state}
              className={`truncate rounded px-2 py-1 text-left text-sm hover:bg-gray-100 ${cls}`}
              title={claim.text}
            >
              {icon} {idx}. {claim.text}
            </button>
          );
        })}
      </div>
      {claims.length > 4 && (
        <Button
          size="xs"
          variant="subtle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? "show less ▴" : `show ${claims.length - 4} more ▾`}
        </Button>
      )}
    </div>
  );
}
