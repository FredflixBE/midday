import { describe, expect, test } from "bun:test";
import { isTeamPath } from "@api/utils/team-path";

const team = "daafae20-5d4c-48da-8490-798156eff1ef";
const other = "11111111-2222-3333-4444-555555555555";

describe("isTeamPath", () => {
  test("accepts a file under the team's own folder", () => {
    expect(isTeamPath(team, `${team}/quotes/picture.png`)).toBe(true);
    expect(isTeamPath(team, `${team}/inbox/receipt.pdf`)).toBe(true);
  });

  test("refuses another team's folder", () => {
    expect(isTeamPath(team, `${other}/quotes/picture.png`)).toBe(false);
    expect(isTeamPath(team, `${team}extra/quotes/picture.png`)).toBe(false);
  });

  test("refuses a path that walks out of the folder", () => {
    expect(isTeamPath(team, `${team}/../${other}/secret.png`)).toBe(false);
    expect(isTeamPath(team, `${team}/quotes/../../${other}/secret.png`)).toBe(
      false,
    );
    expect(isTeamPath(team, `${team}/./quotes/picture.png`)).toBe(false);
  });

  test("refuses a path that names no file", () => {
    expect(isTeamPath(team, team)).toBe(false);
    expect(isTeamPath(team, `${team}/`)).toBe(false);
    expect(isTeamPath(team, "")).toBe(false);
  });
});
