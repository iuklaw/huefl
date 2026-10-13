import { describe, expect, it } from "vitest";
import { depthOrder, floorAt, heightAt, positionColor, project } from "./room";

describe("project", () => {
  it("the floor is a diamond: back corner on top, viewer's corner at the bottom", () => {
    const back = project({ x: -1, y: 1, z: -1 });
    const front = project({ x: 1, y: -1, z: -1 });
    const left = project({ x: -1, y: -1, z: -1 });
    const right = project({ x: 1, y: 1, z: -1 });
    expect(back.sx).toBeCloseTo(0);
    expect(front.sx).toBeCloseTo(0);
    expect(back.sy).toBeLessThan(front.sy);
    expect(left.sx).toBeLessThan(0);
    expect(right.sx).toBeGreaterThan(0);
  });

  it("the screen's wall is back-right: its middle is right of the room's middle, and further back", () => {
    const screen = project({ x: 0, y: 1, z: -1 });
    expect(screen.sx).toBeGreaterThan(0);
    expect(screen.sy).toBeLessThan(0);
  });

  it("higher is drawn higher", () => {
    expect(project({ x: 0, y: 0, z: 1 }).sy).toBeLessThan(project({ x: 0, y: 0, z: -1 }).sy);
  });
});

describe("dragging", () => {
  it("floorAt undoes the projection at any height", () => {
    const p = { x: 0.3, y: -0.6, z: 0.5 };
    const { sx, sy } = project(p);
    const floor = floorAt(sx, sy, p.z);
    expect(floor.x).toBeCloseTo(p.x);
    expect(floor.y).toBeCloseTo(p.y);
  });

  it("heightAt undoes the projection", () => {
    const p = { x: -0.4, y: 0.2, z: -0.25 };
    expect(heightAt(project(p).sy, p)).toBeCloseTo(p.z);
  });

  it("keeps lights inside the room", () => {
    expect(floorAt(1000, 0, 0)).toEqual({ x: 1, y: 1 });
    expect(heightAt(-1000, { x: 0, y: 0 })).toBe(1);
    expect(heightAt(1000, { x: 0, y: 0 })).toBe(-1);
  });
});

describe("positionColor", () => {
  it("differs around the room and with height", () => {
    const corners = [
      { x: -1, y: -1, z: 0 },
      { x: 1, y: -1, z: 0 },
      { x: 1, y: 1, z: 0 },
      { x: -1, y: 1, z: 0 },
    ].map((p) => positionColor(p, "location"));
    expect(new Set(corners).size).toBe(4);
    expect(positionColor({ x: 0, y: 0, z: -1 }, "height")).not.toBe(
      positionColor({ x: 0, y: 0, z: 1 }, "height"),
    );
    expect(corners[0]).toMatch(/^#[0-9A-F]{6}$/);
  });
});

describe("depthOrder", () => {
  it("draws lights nearer the viewer last", () => {
    const positions = new Map([
      ["near", { x: 0.8, y: -0.8, z: 0 }],
      ["far", { x: -0.8, y: 0.8, z: 0 }],
      ["middle", { x: 0, y: 0, z: 0 }],
    ]);
    expect(depthOrder(positions)).toEqual(["far", "middle", "near"]);
  });
});
