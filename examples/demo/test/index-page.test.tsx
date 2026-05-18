/**
 * Tests for the `/` index page.
 *
 * Verifies the form-driven submission flow: filling in Transcript +
 * HGVS-c, clicking Analyze, then asserting the page POSTs to
 * `/api/runs` with the right body and navigates to `/variants/[id]`
 * on success. The history scan logic itself is tested in
 * `runs.test.ts` and `runs-route.test.ts`; this file only covers the
 * wire-up.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MantineProvider } from "@mantine/core";

const pushMock = vi.fn();

vi.mock("next/router", () => ({
  useRouter: () => ({ push: pushMock }),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import IndexPage from "../src/pages/index";

let fetchSpy: ReturnType<typeof vi.spyOn>;

function arrangeFetch(plan: {
  history?: { runs: unknown[]; total: number; page: number; pageSize: number };
  submitResponse?: { status: number; body: object | string };
}) {
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    if (url.startsWith("/api/runs?")) {
      return Promise.resolve(
        new Response(
          JSON.stringify(
            plan.history ?? { runs: [], total: 0, page: 1, pageSize: 20 },
          ),
          { status: 200 },
        ),
      );
    }
    if (url === "/api/runs" && (init?.method ?? "GET") === "POST") {
      const out = plan.submitResponse ?? {
        status: 200,
        body: {
          run_id: "abc".repeat(11) + "f",
          variant_id: "NM_001035_3-c_14174A_G",
          started_at: "2026-05-15T00:00:00.000+00:00",
          status: "running",
        },
      };
      const bodyStr =
        typeof out.body === "string" ? out.body : JSON.stringify(out.body);
      return Promise.resolve(new Response(bodyStr, { status: out.status }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  });
}

function renderPage() {
  return render(
    <MantineProvider>
      <IndexPage />
    </MantineProvider>,
  );
}

beforeEach(() => {
  pushMock.mockReset();
});

afterEach(() => {
  cleanup();
  if (fetchSpy) fetchSpy.mockRestore();
});

describe("/ index page", () => {
  test("renders the submission form with placeholder + description on each field", async () => {
    arrangeFetch({});
    renderPage();
    expect(
      await screen.findByPlaceholderText(/NM_001035\.3/),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/c\.14174A>G/)).toBeInTheDocument();
    expect(
      screen.getByText(/RefSeq transcript identifier/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Coding-DNA notation, c\.-form only/),
    ).toBeInTheDocument();
  });

  test("submits {transcript, hgvs_c} (snake_case) and navigates on success", async () => {
    arrangeFetch({});
    renderPage();

    const transcript = await screen.findByTestId("transcript-input");
    const hgvs = screen.getByTestId("hgvs-input");
    fireEvent.change(transcript, { target: { value: "NM_001035.3" } });
    fireEvent.change(hgvs, { target: { value: "c.14174A>G" } });

    fireEvent.click(screen.getByTestId("submit-button"));

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/variants/NM_001035_3-c_14174A_G");
    });
    const postCall = fetchSpy.mock.calls.find(
      ([, init]: [unknown, RequestInit?]) => (init?.method ?? "GET") === "POST",
    );
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body).toEqual({
      transcript: "NM_001035.3",
      hgvs_c: "c.14174A>G",
    });
  });

  test("rejects an empty submission with a client-side message", async () => {
    arrangeFetch({});
    renderPage();
    fireEvent.click(screen.getByTestId("submit-button"));
    expect(
      await screen.findByText(/Transcript and HGVS c\. are both required/),
    ).toBeInTheDocument();
    // No POST should have fired.
    const postCalls = fetchSpy.mock.calls.filter(
      ([, init]: [unknown, RequestInit?]) => (init?.method ?? "GET") === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  test("surfaces a server error from /api/runs", async () => {
    arrangeFetch({
      submitResponse: { status: 409, body: "run already in flight" },
    });
    renderPage();
    fireEvent.change(screen.getByTestId("transcript-input"), {
      target: { value: "NM_001035.3" },
    });
    fireEvent.change(screen.getByTestId("hgvs-input"), {
      target: { value: "c.14174A>G" },
    });
    fireEvent.click(screen.getByTestId("submit-button"));

    expect(
      await screen.findByText(/Submission failed \(409\)/),
    ).toBeInTheDocument();
    expect(pushMock).not.toHaveBeenCalled();
  });

  test("renders history rows when /api/runs returns entries", async () => {
    arrangeFetch({
      history: {
        runs: [
          {
            run_id: "a".repeat(32),
            variant_id: "NM_001035_3-c_14174A_G",
            hgvs_c: "NM_001035.3:c.14174A>G",
            started_at: "2026-05-15T00:00:00.000+00:00",
            terminal: true,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    renderPage();
    expect(await screen.findByTestId("runs-history-table")).toBeInTheDocument();
    expect(screen.getByText("NM_001035_3-c_14174A_G")).toBeInTheDocument();
    expect(screen.getByText("NM_001035.3:c.14174A>G")).toBeInTheDocument();
    expect(screen.getByText("Done")).toBeInTheDocument();
  });
});
