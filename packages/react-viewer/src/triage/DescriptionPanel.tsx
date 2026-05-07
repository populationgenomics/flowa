import { Text } from "@mantine/core";
import { LlmContent } from "../llm-content/LlmContent";
import type { PaperIdMapping } from "../citations/types";

export interface DescriptionPanelProps {
  content: string | null | undefined;
  paperIdMapping: PaperIdMapping;
  onCitationClick?: (parsed: { paperId: string; quote: string }) => void;
}

export function DescriptionPanel({
  content,
  paperIdMapping,
  onCitationClick,
}: DescriptionPanelProps) {
  return (
    <div
      className="overflow-y-auto rounded-lg border-2 border-blue-200 bg-blue-50 px-3 pb-3"
      data-testid="description-panel"
    >
      <div className="sticky top-0 z-10 -mx-3 mb-3 rounded-t-lg border-b border-blue-200 bg-blue-50 px-3 pb-2 pt-2">
        <Text
          size="xs"
          fw={700}
          className="uppercase tracking-wide text-blue-700"
        >
          Description
        </Text>
      </div>
      <div className="prose prose-sm max-w-none text-sm">
        <LlmContent
          markdown={content ?? null}
          paperIdMapping={paperIdMapping}
          onCitationClick={onCitationClick}
        />
      </div>
    </div>
  );
}
