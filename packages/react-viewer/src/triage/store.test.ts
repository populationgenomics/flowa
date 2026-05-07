import { afterEach, describe, expect, it } from "vitest";
import { claimKey, useTriageStore } from "./store";

afterEach(() => {
  useTriageStore.getState().reset();
});

describe("claimKey", () => {
  it("joins paperId and claimIndex with a newline", () => {
    expect(claimKey("Smith2024", 3)).toBe("Smith2024\n3");
  });
});

describe("loadFromServer", () => {
  it("populates the store from a backend snapshot", () => {
    useTriageStore.getState().loadFromServer({
      workspaceKey: { variantId: "F508del", category: "acmg", version: 0 },
      claims: [
        { paperId: "Smith2024", claimIndex: 1, state: "ACCEPTED" },
        { paperId: "Smith2024", claimIndex: 2, state: "REJECTED" },
      ],
      papers: [
        {
          paperId: "Smith2024",
          triageDoneAt: new Date("2026-05-07T00:00:00Z"),
          triageDoneBy: "alice",
        },
      ],
      comments: [{ paperId: "Smith2024", claimIndex: 1, body: "looks solid" }],
    });

    const s = useTriageStore.getState();
    expect(s.workspaceKey).toEqual({
      variantId: "F508del",
      category: "acmg",
      version: 0,
    });
    expect(s.claimStates[claimKey("Smith2024", 1)]).toBe("ACCEPTED");
    expect(s.claimStates[claimKey("Smith2024", 2)]).toBe("REJECTED");
    expect(s.papersDone["Smith2024"]?.triageDoneBy).toBe("alice");
    expect(s.comments[claimKey("Smith2024", 1)]).toBe("looks solid");
  });
});

describe("optimistic mutators return previous values", () => {
  it("applyClaimState returns the previous state and writes the new one", () => {
    const prev = useTriageStore
      .getState()
      .applyClaimState("Smith2024", 1, "ACCEPTED");
    expect(prev).toBe("UNREVIEWED");
    expect(
      useTriageStore.getState().claimStates[claimKey("Smith2024", 1)],
    ).toBe("ACCEPTED");

    const prev2 = useTriageStore
      .getState()
      .applyClaimState("Smith2024", 1, "REJECTED");
    expect(prev2).toBe("ACCEPTED");
    expect(
      useTriageStore.getState().claimStates[claimKey("Smith2024", 1)],
    ).toBe("REJECTED");
  });

  it("applyPaperDone toggles and reports the previous done state", () => {
    expect(
      useTriageStore.getState().applyPaperDone("Smith2024", true, "alice"),
    ).toBe(false);
    expect(
      useTriageStore.getState().papersDone["Smith2024"]?.triageDoneBy,
    ).toBe("alice");

    expect(
      useTriageStore.getState().applyPaperDone("Smith2024", false, "alice"),
    ).toBe(true);
    expect(useTriageStore.getState().papersDone["Smith2024"]).toBeUndefined();
  });

  it("applyClaimComment returns the previous body and clears on empty", () => {
    const prev = useTriageStore
      .getState()
      .applyClaimComment("Smith2024", 1, "first version");
    expect(prev).toBe("");
    expect(useTriageStore.getState().comments[claimKey("Smith2024", 1)]).toBe(
      "first version",
    );

    const prev2 = useTriageStore
      .getState()
      .applyClaimComment("Smith2024", 1, "");
    expect(prev2).toBe("first version");
    expect(
      useTriageStore.getState().comments[claimKey("Smith2024", 1)],
    ).toBeUndefined();
  });
});

describe("focus + drawer + reset", () => {
  it("focusPaper resets the claim cursor to 1", () => {
    useTriageStore.getState().focusClaim("Smith2024", 5);
    useTriageStore.getState().focusPaper("Jones2023");
    expect(useTriageStore.getState().focusedPaperId).toBe("Jones2023");
    expect(useTriageStore.getState().focusedClaimIndex).toBe(1);
  });

  it("toggleChatDrawer flips when no arg, sets explicitly when given a bool", () => {
    expect(useTriageStore.getState().chatDrawerOpen).toBe(false);
    useTriageStore.getState().toggleChatDrawer();
    expect(useTriageStore.getState().chatDrawerOpen).toBe(true);
    useTriageStore.getState().toggleChatDrawer(false);
    expect(useTriageStore.getState().chatDrawerOpen).toBe(false);
  });

  it("reset returns the store to its initial shape", () => {
    useTriageStore.getState().applyClaimState("Smith2024", 1, "ACCEPTED");
    useTriageStore.getState().reset();
    const s = useTriageStore.getState();
    expect(s.workspaceKey).toBeNull();
    expect(s.claimStates).toEqual({});
    expect(s.papersDone).toEqual({});
    expect(s.comments).toEqual({});
  });
});
