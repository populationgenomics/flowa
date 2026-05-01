// @vitest-environment happy-dom

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { LlmContent } from "./LlmContent";
import type { PaperIdMapping } from "../citations/types";

const MAPPING: PaperIdMapping = {
  byAuthorYear: { Cook2023: { doi: "10.1002/humu.23595" } },
  byDoi: { "10.1002/humu.23595": "Cook2023" },
};

describe("LlmContent", () => {
  it("renders plain Markdown", () => {
    render(<LlmContent markdown="**bold** text" paperIdMapping={MAPPING} />);
    expect(screen.getByText("bold")).toBeDefined();
  });

  it("renders nothing for empty input", () => {
    const { container } = render(
      <LlmContent markdown="" paperIdMapping={MAPPING} />,
    );
    expect(container.textContent).toBe("");
  });

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

  it("strips citation links when no onCitationClick handler", () => {
    render(
      <LlmContent
        markdown='See [Cook 2023](#cite:Cook2023 "quote").'
        paperIdMapping={MAPPING}
      />,
    );
    expect(screen.queryByTestId("citation-link")).toBeNull();
    expect(screen.getByText(/Cook 2023/)).toBeDefined();
  });

  it("strips invalid citation links to plain text", () => {
    const onClick = vi.fn();
    render(
      <LlmContent
        markdown='[Bogus](#cite:BogusKey "some quote")'
        paperIdMapping={MAPPING}
        onCitationClick={onClick}
      />,
    );
    expect(screen.queryByTestId("citation-link")).toBeNull();
    expect(screen.getByText("Bogus")).toBeDefined();
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
    const link = screen.getByTestId("citation-link");
    fireEvent.keyDown(link, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
