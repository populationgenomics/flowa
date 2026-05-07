// Citations
export {
  isCitationHref,
  parseCiteHref,
  parseCitationsFromMarkdown,
  stripInvalidLinks,
  sanitizeLlmMarkdown,
} from "./citations/sanitize";
export type { PaperIdEntry, PaperIdMapping } from "./citations/types";

// LLM-rendered Markdown
export { LlmContent, type LlmContentProps } from "./llm-content/LlmContent";

// PDF viewer with bbox highlights
export {
  PdfHighlightViewer,
  type PdfHighlightViewerProps,
} from "./pdf-viewer/PdfHighlightViewer";
export type { HighlightBbox, PdfHighlight } from "./pdf-viewer/types";

// Triage workspace — types and helpers
export type {
  Claim,
  ClaimCitation,
  RankedPaper,
  CategorySuggestion,
  TriageStateValue,
  WorkspaceKey,
  VersionEntry,
} from "./triage/types";
export {
  groupClaimsByPaper,
  resolveClaimForCitation,
  indexClaimsByPaperIdAndText,
  type ClaimRef,
} from "./triage/claim-refs";
export {
  flattenClaimCitations,
  formatPaperLabel,
  encodeDoi,
  type FlatCitation,
} from "./triage/citation-utils";
