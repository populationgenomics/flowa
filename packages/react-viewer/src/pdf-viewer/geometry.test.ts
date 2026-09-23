import { describe, it, expect } from "vitest";
import { rotateBbox, turn, SCALE, type Rotation } from "./geometry";
import type { HighlightBbox } from "./types";

// A box in the top-left quadrant, wider than tall, so every turn moves it
// to a different quadrant and swaps its sides.
const BOX: HighlightBbox = {
  page: 3,
  left: 100,
  top: 200,
  right: 400,
  bottom: 250,
};

describe("rotateBbox", () => {
  it("returns the box unchanged at 0", () => {
    expect(rotateBbox(BOX, 0)).toBe(BOX);
  });

  it("sends the left edge to the top edge on a clockwise quarter turn", () => {
    // Top-left of the page ends up top-right, so the box's horizontal
    // extent becomes vertical and sits near the right edge.
    expect(rotateBbox(BOX, 90)).toEqual({
      page: 3,
      left: SCALE - 250,
      right: SCALE - 200,
      top: 100,
      bottom: 400,
    });
  });

  it("mirrors both axes at 180", () => {
    expect(rotateBbox(BOX, 180)).toEqual({
      page: 3,
      left: SCALE - 400,
      right: SCALE - 100,
      top: SCALE - 250,
      bottom: SCALE - 200,
    });
  });

  it("sends the top edge to the left edge on an anticlockwise quarter turn", () => {
    expect(rotateBbox(BOX, 270)).toEqual({
      page: 3,
      left: 200,
      right: 250,
      top: SCALE - 400,
      bottom: SCALE - 100,
    });
  });

  it("keeps the box well formed and composes to the identity over four turns", () => {
    let box = BOX;
    for (let i = 0; i < 4; i++) {
      box = rotateBbox(box, 90);
      expect(box.left).toBeLessThan(box.right);
      expect(box.top).toBeLessThan(box.bottom);
    }
    expect(box).toEqual(BOX);
  });

  it("is undone by the opposite turn", () => {
    expect(rotateBbox(rotateBbox(BOX, 90), 270)).toEqual(BOX);
    expect(rotateBbox(rotateBbox(BOX, 270), 90)).toEqual(BOX);
    expect(rotateBbox(rotateBbox(BOX, 180), 180)).toEqual(BOX);
  });

  it("agrees with the equivalent number of single turns", () => {
    const once = rotateBbox(BOX, 90);
    expect(rotateBbox(once, 90)).toEqual(rotateBbox(BOX, 180));
    expect(rotateBbox(rotateBbox(once, 90), 90)).toEqual(rotateBbox(BOX, 270));
  });
});

describe("turn", () => {
  it("steps through the four rotations in both directions", () => {
    const clockwise: Rotation[] = [0];
    for (let i = 0; i < 4; i++) clockwise.push(turn(clockwise[i]!, 1));
    expect(clockwise).toEqual([0, 90, 180, 270, 0]);
    expect(turn(0, -1)).toBe(270);
    expect(turn(270, 1)).toBe(0);
  });
});
