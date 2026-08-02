import { describe, expect, it } from "vitest";
import { relativeTime } from "../relative-time";

// A fake translator that just stringifies the key and any interpolated count, so assertions can
// check which key/count relativeTime chose without depending on the real English dictionary.
const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${vars.count}` : key;

function isoMinutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

describe("relativeTime", () => {
  it("returns justNow for under a minute", () => {
    expect(relativeTime(isoMinutesAgo(0), t)).toBe("relativeTime.justNow");
  });

  it("uses the singular minute key for exactly one minute", () => {
    expect(relativeTime(isoMinutesAgo(1), t)).toBe("relativeTime.minuteOne:1");
  });

  it("uses the plural minute key under an hour", () => {
    expect(relativeTime(isoMinutesAgo(30), t)).toBe("relativeTime.minuteOther:30");
  });

  it("uses the singular hour key for exactly one hour", () => {
    expect(relativeTime(isoMinutesAgo(60), t)).toBe("relativeTime.hourOne:1");
  });

  it("uses the plural hour key under a day", () => {
    expect(relativeTime(isoMinutesAgo(5 * 60), t)).toBe("relativeTime.hourOther:5");
  });

  it("uses the plural day key for multiple days", () => {
    expect(relativeTime(isoMinutesAgo(3 * 24 * 60), t)).toBe("relativeTime.dayOther:3");
  });
});
