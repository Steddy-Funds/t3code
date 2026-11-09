import { describe, expect, it } from "vite-plus/test";

import { countFinishedTurns, type TurnTallies } from "./gambaMode.logic";

type Shell = Parameters<typeof countFinishedTurns>[1][number];

const shell = (id: string, overrides: Partial<Shell> = {}): Shell => ({
  id: id as Shell["id"],
  status: "idle",
  latestRunId: null,
  ...overrides,
});
const run = (id: string) => id as NonNullable<Shell["latestRunId"]>;

function observe(sequence: ReadonlyArray<ReadonlyArray<Shell> | null>) {
  let tallies: TurnTallies | null = null;
  const coins: Array<number> = [];
  for (const threads of sequence) {
    if (threads === null) {
      tallies = null;
      continue;
    }
    const result = countFinishedTurns(tallies, threads);
    tallies = result.tallies;
    coins.push(result.coins);
  }
  return coins;
}

describe("countFinishedTurns", () => {
  it("pays once per completed run and never for the first snapshot", () => {
    expect(
      observe([
        [shell("a", { status: "completed", latestRunId: run("r1") })],
        [shell("a", { status: "running", latestRunId: run("r2") })],
        [shell("a", { status: "completed", latestRunId: run("r2") })],
        [shell("a", { status: "completed", latestRunId: run("r2") })],
        [shell("a", { status: "failed", latestRunId: run("r3") })],
      ]),
    ).toEqual([0, 0, 1, 0, 0]);
  });

  it("pays for every child and native subagent finishing in one update", () => {
    expect(
      observe([
        [
          shell("parent", { status: "running", latestRunId: run("p1") }),
          shell("child-1", { status: "running", latestRunId: run("c1") }),
          shell("child-2", { status: "running", latestRunId: run("c2") }),
        ],
        [
          shell("parent", {
            status: "running",
            latestRunId: run("p1"),
            nativeSubagentsCompleted: 3,
          }),
          shell("child-1", { status: "completed", latestRunId: run("c1") }),
          shell("child-2", { status: "completed", latestRunId: run("c2") }),
        ],
      ]),
    ).toEqual([0, 5]);
  });

  it("takes a fresh baseline after a reconnect", () => {
    expect(
      observe([
        [shell("a", { status: "running", latestRunId: run("r1") })],
        null,
        [shell("a", { status: "completed", latestRunId: run("r1"), nativeSubagentsCompleted: 2 })],
      ]),
    ).toEqual([0, 0]);
  });
});
