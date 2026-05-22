import { Text } from "@mantine/core";
import { LlmContent } from "../llm-content/LlmContent";
import type { PaperIdMapping } from "../citations/types";

export interface SynthesisPanelProps {
  description: string | null | undefined;
  notes: string | null | undefined;
  paperIdMapping: PaperIdMapping;
  onCitationClick?: (parsed: { paperId: string; quote: string }) => void;
}

function SectionHeading({ children }: { children: string }) {
  return (
    <Text size="xs" fw={700} className="uppercase tracking-wide text-blue-700">
      {children}
    </Text>
  );
}

export function SynthesisPanel({
  description,
  notes,
  paperIdMapping,
  onCitationClick,
}: SynthesisPanelProps) {
  return (
    <div
      className="rounded-lg border-2 border-blue-200 bg-blue-50"
      data-testid="synthesis-panel"
    >
      <section className="px-3 pb-3 pt-2">
        <SectionHeading>Description</SectionHeading>
        <div className="flowa-llm-content mt-2">
          <LlmContent
            markdown={description ?? null}
            paperIdMapping={paperIdMapping}
            onCitationClick={onCitationClick}
          />
        </div>
      </section>
      <section className="border-t border-blue-200 px-3 pb-3 pt-3">
        <SectionHeading>Notes</SectionHeading>
        <div className="flowa-llm-content mt-2">
          <LlmContent
            markdown={notes ?? null}
            paperIdMapping={paperIdMapping}
            onCitationClick={onCitationClick}
          />
        </div>
      </section>
    </div>
  );
}
