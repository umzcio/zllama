import { describe, it, expect } from "vitest";
import en from "../en.json";
import es from "../es.json";
import ca from "../ca.json";
import fr from "../fr.json";
import hi from "../hi.json";
import ja from "../ja.json";
import zh from "../zh.json";

const LOCALES = { en, es, ca, fr, hi, ja, zh } as Record<string, typeof en>;

const UPSTREAM_ROLES_KEYS = [
  "checkedAgo",
  "checkNow",
  "upstreamUnknown",
  "upstreamStaleHint",
  "upstreamCurrent",
  "upstreamUpdateAvailable",
  "upstreamPinLabel",
  "upstreamLatestLabel",
  "upstreamBumpTo",
];

const UPSTREAM_DRIFT_KEYS = ["upstreamBanner"];

describe("upstream release locale keys", () => {
  it("defines every upstream key for admin.roles in all 7 locales", () => {
    const locales = Object.entries(LOCALES);
    expect(locales).toHaveLength(7);

    for (const [locale, messages] of locales) {
      for (const key of UPSTREAM_ROLES_KEYS) {
        expect(messages.admin.roles, `admin.roles.${key} missing in ${locale}`).toHaveProperty(key);
        expect(
          typeof (messages.admin.roles as Record<string, unknown>)[key],
          `admin.roles.${key} must be a string in ${locale}`
        ).toBe("string");
      }
    }
  });

  it("defines every upstream key for admin.drift in all 7 locales", () => {
    const locales = Object.entries(LOCALES);
    expect(locales).toHaveLength(7);

    for (const [locale, messages] of locales) {
      for (const key of UPSTREAM_DRIFT_KEYS) {
        expect(messages.admin.drift, `admin.drift.${key} missing in ${locale}`).toHaveProperty(key);
        expect(
          typeof (messages.admin.drift as Record<string, unknown>)[key],
          `admin.drift.${key} must be a string in ${locale}`
        ).toBe("string");
      }
    }
  });

  it("keeps admin.roles and admin.drift key counts equal across all 7 locales", () => {
    const rolesCounts = Object.entries(LOCALES).map(
      ([locale, messages]) => [locale, Object.keys(messages.admin.roles).length] as const
    );
    const driftCounts = Object.entries(LOCALES).map(
      ([locale, messages]) => [locale, Object.keys(messages.admin.drift).length] as const
    );

    const [, firstRolesCount] = rolesCounts[0];
    const [, firstDriftCount] = driftCounts[0];

    for (const [locale, count] of rolesCounts) {
      expect(count, `admin.roles key count mismatch in ${locale}`).toBe(firstRolesCount);
    }
    for (const [locale, count] of driftCounts) {
      expect(count, `admin.drift key count mismatch in ${locale}`).toBe(firstDriftCount);
    }
  });
});
