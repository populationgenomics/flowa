// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LlmContent } from "./LlmContent";
import type { PaperIdMapping } from "../citations/types";

const MAPPING: PaperIdMapping = {
  byAuthorYear: {
    Cook2023: { doi: "10.1002/humu.23595" },
    Weiss2023: { doi: "10.2169/internalmedicine.9843-17", pmid: 29434162 },
  },
  byDoi: {
    "10.1002/humu.23595": "Cook2023",
    "10.2169/internalmedicine.9843-17": "Weiss2023",
  },
};

describe("LlmContent — rendering", () => {
  it("renders plain Markdown", () => {
    render(
      <LlmContent markdown="**bold** and _italic_" paperIdMapping={MAPPING} />,
    );
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
  });

  it("renders nothing for empty input", () => {
    const { container } = render(
      <LlmContent markdown="" paperIdMapping={MAPPING} />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders GFM tables", () => {
    const md = ["| Gene | Effect |", "|---|---|", "| TUBB1 | LoF |"].join("\n");
    const { container } = render(
      <LlmContent markdown={md} paperIdMapping={MAPPING} />,
    );
    expect(container.querySelector("table")).not.toBeNull();
    expect(screen.getByText("TUBB1")).toBeDefined();
    expect(screen.getByText("LoF")).toBeDefined();
  });
});

describe("LlmContent — citation links", () => {
  it("renders citation as clickable span when onCitationClick provided", () => {
    const onClick = vi.fn();
    render(
      <LlmContent
        markdown='See [Cook 2023](#cite:Cook2023 "complete loss of activity").'
        paperIdMapping={MAPPING}
        onCitationClick={onClick}
      />,
    );
    const link = screen.getByTestId("citation-link");
    expect(link.textContent).toBe("Cook 2023");
    fireEvent.click(link);
    expect(onClick).toHaveBeenCalledWith({
      paperId: "Cook2023",
      quote: "complete loss of activity",
    });
  });

  it("activates citation on Enter key", () => {
    const onClick = vi.fn();
    render(
      <LlmContent
        markdown='[Cook 2023](#cite:Cook2023 "q")'
        paperIdMapping={MAPPING}
        onCitationClick={onClick}
      />,
    );
    fireEvent.keyDown(screen.getByTestId("citation-link"), { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("strips citation links to plain text when no onCitationClick handler", () => {
    const { container } = render(
      <LlmContent
        markdown='See [Cook 2023](#cite:Cook2023 "quote").'
        paperIdMapping={MAPPING}
      />,
    );
    expect(screen.queryByTestId("citation-link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText(/Cook 2023/)).toBeDefined();
  });

  it("strips citations with an unknown AuthorYear", () => {
    const onClick = vi.fn();
    const { container } = render(
      <LlmContent
        markdown='[Bogus](#cite:BogusKey "some quote")'
        paperIdMapping={MAPPING}
        onCitationClick={onClick}
      />,
    );
    expect(screen.queryByTestId("citation-link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("Bogus")).toBeDefined();
  });

  it("strips syntactically invalid citation hrefs", () => {
    const onClick = vi.fn();
    const { container } = render(
      <LlmContent
        markdown='[text](#cite:invalid:42 "q")'
        paperIdMapping={MAPPING}
        onCitationClick={onClick}
      />,
    );
    expect(screen.queryByTestId("citation-link")).toBeNull();
    expect(container.querySelector("a")).toBeNull();
    expect(screen.getByText("text")).toBeDefined();
  });

  it("keeps only the valid citation among mixed valid/invalid/external links", () => {
    const onClick = vi.fn();
    const { container } = render(
      <LlmContent
        markdown={
          '[valid](#cite:Cook2023 "q") and [bad](https://evil.com) and [bogus](#cite:BogusKey "q2")'
        }
        paperIdMapping={MAPPING}
        onCitationClick={onClick}
      />,
    );
    // Exactly one active citation; everything else stripped to text.
    expect(screen.getAllByTestId("citation-link")).toHaveLength(1);
    expect(screen.getByTestId("citation-link").textContent).toBe("valid");
    // No raw anchors survive (valid → span, others → bare text).
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("bad");
    expect(container.textContent).toContain("bogus");
    expect(container.textContent).not.toContain("evil.com");
  });
});

describe("LlmContent — untrusted-input safety", () => {
  it("renders raw HTML inert (no live script/img elements)", () => {
    const { container } = render(
      <LlmContent
        markdown="Safe text <script>alert('xss')</script> <img src=x onerror=alert(2)> more text"
        paperIdMapping={MAPPING}
      />,
    );
    // react-markdown escapes raw HTML (no `rehype-raw`), so the dangerous
    // markup never becomes a live element — the XSS vectors are neutralized
    // even though the characters may remain as visible text.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Safe text");
    expect(container.textContent).toContain("more text");
  });

  it("strips external links to plain text", () => {
    const { container } = render(
      <LlmContent
        markdown="[Click me](https://evil.com) is bad."
        paperIdMapping={MAPPING}
        onCitationClick={vi.fn()}
      />,
    );
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("Click me");
    expect(container.textContent).not.toContain("evil.com");
  });

  it("neutralizes javascript: URLs", () => {
    const { container } = render(
      // eslint-disable-next-line no-script-url
      <LlmContent
        markdown="[x](javascript:alert(1))"
        paperIdMapping={MAPPING}
        onCitationClick={vi.fn()}
      />,
    );
    const anchor = container.querySelector("a");
    // react-markdown's urlTransform blanks dangerous protocols; our renderer
    // additionally only ever emits spans for #cite: hrefs, so no live anchor
    // with a javascript: target can reach the DOM.
    expect(anchor?.getAttribute("href") ?? "").not.toContain("javascript:");
    expect(container.textContent).toContain("x");
  });
});
