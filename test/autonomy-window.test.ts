import { test, expect, describe } from "bun:test";
import {
  withinWindow, parseExtensionDeadline, windowLabel, actingAllowed, AUTONOMY_EXTENSION_CAP_MS,
  type WindowConfig,
} from "../src/shared/autonomy-window.ts";

const UTC: WindowConfig = { timeZone: "UTC", startHour: 9, endHour: 21 };
const mon10 = Date.parse("2026-01-05T10:00:00Z"); // Monday 10:00
const mon22 = Date.parse("2026-01-05T22:00:00Z"); // Monday 22:00
const sat12 = Date.parse("2026-01-03T12:00:00Z"); // Saturday 12:00

describe("withinWindow (design §13.7)", () => {
  test("weekday inside 9-21 is in-window; outside and weekends are not", () => {
    expect(withinWindow(mon10, UTC)).toBe(true);
    expect(withinWindow(mon22, UTC)).toBe(false);
    expect(withinWindow(Date.parse("2026-01-05T08:00:00Z"), UTC)).toBe(false);
    expect(withinWindow(sat12, UTC)).toBe(false);
  });
});

describe("parseExtensionDeadline (design §13.7)", () => {
  const now = 1_000_000_000;
  test("garbage and past timestamps do not open the window", () => {
    expect(parseExtensionDeadline("abc", now)).toBeNull();
    expect(parseExtensionDeadline(String(now - 1000), now)).toBeNull();
  });
  test("a future deadline is honored; beyond 12h is capped", () => {
    expect(parseExtensionDeadline(String(now + 3_600_000), now)).toBe(now + 3_600_000);
    expect(parseExtensionDeadline(String(now + 24 * 3_600_000), now)).toBe(now + AUTONOMY_EXTENSION_CAP_MS);
  });
});

describe("windowLabel + actingAllowed", () => {
  test("labels reflect the state", () => {
    expect(windowLabel(mon10, UTC, null)).toBe("9-21");
    expect(windowLabel(mon22, UTC, null)).toBe("off-hours");
    expect(windowLabel(sat12, UTC, null)).toBe("weekend");
    expect(windowLabel(mon22, UTC, mon22 + 2 * 3_600_000)).toMatch(/^\+2h00m$/);
  });
  test("actingAllowed = in-window OR a live extension", () => {
    expect(actingAllowed(mon10, UTC, null)).toBe(true);
    expect(actingAllowed(mon22, UTC, null)).toBe(false);
    expect(actingAllowed(mon22, UTC, mon22 + 60_000)).toBe(true);
  });
});
