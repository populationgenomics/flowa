// Citations
export {
  isCitationHref,
  parseCiteHref,
  parseCitationsFromMarkdown,
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

// Markdown viewer with anchor highlights
export {
  MarkdownHighlightViewer,
  type MarkdownHighlightViewerProps,
} from "./markdown-viewer/MarkdownHighlightViewer";
export type { CodePointAnchor } from "./markdown-viewer/types";

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
export {
  useTriageStore,
  claimKey,
  type TriageStore,
  type TriageStoreData,
  type TriageStoreActions,
  type ClaimKey,
} from "./triage/store";
export { useTriageKeyboard, jumpToNextUnreviewed } from "./triage/keyboard";
export type { TriageBackend, TriageSnapshotPayload } from "./triage/backend";

// Triage workspace — render components
export { ClaimList, type ClaimListProps } from "./triage/ClaimList";
export { FocusCard, type FocusCardProps } from "./triage/FocusCard";
export { PaperHeader, type PaperHeaderProps } from "./triage/PaperHeader";
export {
  SynthesisPanel,
  type SynthesisPanelProps,
} from "./triage/SynthesisPanel";
export { PaperRail, type PaperRailProps } from "./triage/PaperRail";
export {
  ChatDrawer,
  type ChatDrawerProps,
  type TriageStatePayload,
} from "./triage/ChatDrawer";
export {
  ChatSection,
  type ChatSectionProps,
  type SessionInfo,
} from "./triage/ChatSection";

// Citation resolver (callback contract for chat-introduced citations)
export type {
  CitationQuery,
  CitationResolver,
  ResolvedCitations,
  ResolvedQuote,
} from "./triage/citation-resolver";

// Evidence viewer shell — composes the triage workspace
export {
  EvidenceViewerShell,
  type EvidenceViewerShellProps,
} from "./triage/EvidenceViewerShell";
