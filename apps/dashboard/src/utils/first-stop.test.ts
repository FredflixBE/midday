/**
 * Where sign-in sends a user who cannot use the app yet. An invited user has
 * no team until they accept, so "no team" must lead to their invites, not to
 * onboarding — which would create a second team (FF-1542).
 */
import { expect, test } from "bun:test";
import { firstStop } from "./first-stop";

test("a user without a team goes to /teams, where their invites are", () => {
  expect(firstStop({ fullName: "Support", teamId: null })).toBe("/teams");
});

test("a user without a team or a name still goes to /teams first", () => {
  expect(firstStop({ fullName: null, teamId: null })).toBe("/teams");
});

test("a user with a team but no name finishes their profile in onboarding", () => {
  expect(firstStop({ fullName: null, teamId: "team-1" })).toBe("/onboarding");
});

test("a user with a team and a name goes nowhere first", () => {
  expect(firstStop({ fullName: "Frederik", teamId: "team-1" })).toBeNull();
});

test("a user the API does not know yet goes to onboarding, as before", () => {
  expect(firstStop(null)).toBe("/onboarding");
});
