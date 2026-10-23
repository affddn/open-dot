import { afterEach, expect, test } from "bun:test";
import { nextRun, nextRunAfter, parseSchedule, type Schedule } from "../src/schedule";

// Schedules read the system time zone, so each test picks one and the original comes back after.
const original = Intl.DateTimeFormat().resolvedOptions().timeZone;
afterEach(() => {
  process.env.TZ = original;
});

const utc = (...parts: [number, number, number, number, number]) => Date.UTC(...parts);
const daily = (time: string): Schedule => ({ kind: "daily", time });
const minute = 60_000;

test("a daily time keeps its wall-clock hour across a DST change in the system time zone", () => {
  process.env.TZ = "America/New_York";
  // 09:00 is 14:00 UTC before the March change and 13:00 UTC after it.
  expect(nextRun(daily("09:00"), utc(2026, 2, 7, 13, 0))).toBe(utc(2026, 2, 7, 14, 0));
  expect(nextRun(daily("09:00"), utc(2026, 2, 7, 14, 0))).toBe(utc(2026, 2, 8, 13, 0));
  expect(nextRun(daily("09:00"), utc(2026, 9, 31, 14, 0))).toBe(utc(2026, 10, 1, 14, 0));
});

test("a time skipped by DST runs after the jump, and a repeated time runs only at its first", () => {
  process.env.TZ = "America/New_York";
  // 02:30 doesn't exist on 8 March: it runs at 03:30 EDT, then at 02:30 EDT the next day.
  const gap = nextRun(daily("02:30"), utc(2026, 2, 8, 5, 0));
  expect(gap).toBe(utc(2026, 2, 8, 7, 30));
  expect(nextRun(daily("02:30"), gap)).toBe(utc(2026, 2, 9, 6, 30));
  // 01:30 happens twice on 1 November: first at EDT, and not again an hour later at EST.
  const fold = nextRun(daily("01:30"), utc(2026, 10, 1, 4, 0));
  expect(fold).toBe(utc(2026, 10, 1, 5, 30));
  expect(nextRun(daily("01:30"), fold)).toBe(utc(2026, 10, 2, 6, 30));
});

test("the same schedule follows whichever time zone the system has when it's computed", () => {
  const weekdays: Schedule = { kind: "weekly", days: [1, 2, 3, 4, 5], time: "09:00" };
  // Friday 23 October 2026, 12:00 UTC.
  const friday = utc(2026, 9, 23, 12, 0);
  process.env.TZ = "America/New_York";
  expect(nextRun(weekdays, friday)).toBe(utc(2026, 9, 23, 13, 0));
  process.env.TZ = "Asia/Tokyo";
  // 21:00 Friday in Tokyo, so Monday 09:00 JST.
  expect(nextRun(weekdays, friday)).toBe(utc(2026, 9, 26, 0, 0));
  process.env.TZ = "Europe/London";
  // A single weekly day whose slot passed today waits a week, across BST ending on 25 October.
  expect(nextRun({ kind: "weekly", days: [5], time: "09:00" }, friday)).toBe(
    utc(2026, 9, 30, 9, 0),
  );
});

test("an interval counts real minutes and collapses missed runs into one", () => {
  process.env.TZ = "America/New_York";
  const every: Schedule = { kind: "interval", everyMinutes: 60 };
  // Across the March change, an hour is still 60 minutes.
  expect(nextRun(every, utc(2026, 2, 8, 6, 30))).toBe(utc(2026, 2, 8, 7, 30));
  // Due at 1 minute, back at 35 minutes with 10-minute runs: the next is 41, not 11.
  expect(nextRun({ kind: "interval", everyMinutes: 10 }, 35 * minute, minute)).toBe(41 * minute);
});

test("a schedule is checked and normalized before it's saved", () => {
  expect(parseSchedule({ kind: "weekly", days: [5, 1, 3], time: "09:00" })).toEqual({
    kind: "weekly",
    days: [1, 3, 5],
    time: "09:00",
  });
  expect(parseSchedule({ kind: "interval", everyMinutes: 1 })).toEqual({
    kind: "interval",
    everyMinutes: 1,
  });
  for (const bad of [
    null,
    { kind: "daily", time: "9:00" },
    { kind: "daily", time: "24:00" },
    { kind: "daily", time: "09:00", days: [1] },
    { kind: "weekly", days: [], time: "09:00" },
    { kind: "weekly", days: [1, 1], time: "09:00" },
    { kind: "weekly", days: [7], time: "09:00" },
    { kind: "interval", everyMinutes: 0 },
    { kind: "interval", everyMinutes: 1.5 },
    { kind: "monthly", time: "09:00" },
  ])
    expect(parseSchedule(bad)).toHaveProperty("invalid");
});

test("a status change pauses, and resuming starts after now without catching up", () => {
  const every: Schedule = { kind: "interval", everyMinutes: 10 };
  const armed = { status: "active", schedule: every, nextRunAt: 5 * minute };
  expect(nextRunAfter(armed, { status: "done", schedule: every }, 100 * minute)).toBeNull();
  expect(nextRunAfter(armed, { status: "active", schedule: null }, 100 * minute)).toBeNull();
  // An unchanged armed schedule keeps its run, even one already due.
  expect(nextRunAfter(armed, { status: "active", schedule: every }, 100 * minute)).toBe(5 * minute);
  const paused = { status: "done", schedule: every, nextRunAt: null };
  expect(nextRunAfter(paused, { status: "active", schedule: every }, 100 * minute)).toBe(
    110 * minute,
  );
  const changed = { kind: "interval", everyMinutes: 30 } as const;
  expect(nextRunAfter(armed, { status: "active", schedule: changed }, 100 * minute)).toBe(
    130 * minute,
  );
});
