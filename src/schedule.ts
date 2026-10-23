/**
 * A responsibility's optional schedule: every N minutes, or daily or weekly at a wall-clock time
 * in the system's time zone, read when each next run is computed. Days are 0 (Sunday) to 6.
 */
export type Schedule =
  | { readonly kind: "interval"; readonly everyMinutes: number }
  | { readonly kind: "daily"; readonly time: string }
  | { readonly kind: "weekly"; readonly days: readonly number[]; readonly time: string };

/** The longest repeat interval: a year, in minutes. */
export const maxEveryMinutes = 365 * 24 * 60;

const clock = /^([01]\d|2[0-3]):([0-5]\d)$/;
const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type Fields = Record<string, unknown>;
const object = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const exactly = (value: Fields, keys: readonly string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const whole = (value: unknown, low: number, high: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= low && value <= high;

/** Checks a schedule from a tool or request, with weekly days sorted and each listed once. */
export function parseSchedule(value: unknown): Schedule | { readonly invalid: string } {
  const usage = {
    invalid:
      'A schedule is {kind:"interval", everyMinutes}, {kind:"daily", time:"HH:mm"} or {kind:"weekly", days:[0-6, Sunday is 0], time:"HH:mm"}.',
  };
  if (!object(value)) return usage;
  if (value.kind === "interval" && exactly(value, ["kind", "everyMinutes"])) {
    const every = value.everyMinutes;
    return whole(every, 1, maxEveryMinutes)
      ? { kind: "interval", everyMinutes: every }
      : { invalid: `everyMinutes must be whole minutes from 1 to ${maxEveryMinutes}.` };
  }
  if (value.kind !== "daily" && value.kind !== "weekly") return usage;
  if (!exactly(value, value.kind === "daily" ? ["kind", "time"] : ["kind", "days", "time"]))
    return usage;
  const { time } = value;
  if (typeof time !== "string" || !clock.test(time))
    return { invalid: "time must be 24-hour HH:mm, such as 09:00." };
  if (value.kind === "daily") return { kind: "daily", time };
  const days: number[] = [];
  for (const day of Array.isArray(value.days) ? value.days : [])
    if (whole(day, 0, 6) && !days.includes(day)) days.push(day);
    else return { invalid: "days must list each weekday at most once, as 0 (Sunday) to 6." };
  if (days.length === 0) return { invalid: "days must list at least one weekday." };
  return { kind: "weekly", days: days.toSorted((a, b) => a - b), time };
}

/** The system's IANA time zone, which every local schedule uses. */
export const systemTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * The first run strictly after `now`. An interval steps from `previous`, its last due time, so
 * runs missed while the daemon was down collapse into one, or from `now` when it has none.
 *
 * Local times follow JavaScript's local-time rules: a time skipped by a DST jump runs that day
 * as many minutes after the jump as it was past its start (02:30 becomes 03:30), and a time that
 * occurs twice runs only at its first occurrence. An interval counts real minutes, ignoring DST.
 */
export function nextRun(schedule: Schedule, now: number, previous?: number): number {
  if (schedule.kind === "interval") {
    const every = schedule.everyMinutes * 60_000;
    if (previous === undefined) return now + every;
    return previous + (Math.floor((now - previous) / every) + 1) * every;
  }
  const [hours = 0, minutes = 0] = schedule.time.split(":").map(Number);
  const today = new Date(now);
  // Eight days covers a weekly run whose only slot today has passed.
  for (let offset = 0; offset <= 7; offset++) {
    const year = today.getFullYear();
    const month = today.getMonth();
    const date = today.getDate() + offset;
    // Noon is never inside a DST jump, so it names the intended weekday.
    const weekday = new Date(year, month, date, 12).getDay();
    if (schedule.kind === "weekly" && !schedule.days.includes(weekday)) continue;
    const run = new Date(year, month, date, hours, minutes).getTime();
    if (run > now) return run;
  }
  throw new Error("A schedule has no run in the next eight days.");
}

/** How a schedule reads in the dot's memory and tool answers. */
export function describeSchedule(schedule: Schedule) {
  if (schedule.kind === "interval") return `every ${schedule.everyMinutes} minutes`;
  if (schedule.kind === "daily") return `daily at ${schedule.time}`;
  const days = schedule.days.join(",");
  const named =
    days === "0,1,2,3,4,5,6"
      ? "every day"
      : days === "1,2,3,4,5"
        ? "weekdays"
        : days === "0,6"
          ? "weekends"
          : schedule.days.map((day) => dayNames[day]).join(", ");
  return `${named} at ${schedule.time}`;
}

/**
 * The next run a responsibility should have after a change. Only an active responsibility with a
 * schedule has one. An unchanged schedule that is already armed keeps its run; a new schedule, or
 * one resumed from done or dropped, starts after `now`, never catching up on the paused time.
 */
export function nextRunAfter(
  before: { status: string; schedule: Schedule | null; nextRunAt: number | null },
  after: { status: string; schedule: Schedule | null },
  now: number,
): number | null {
  if (after.status !== "active" || after.schedule === null) return null;
  if (
    before.status === "active" &&
    before.nextRunAt !== null &&
    JSON.stringify(before.schedule) === JSON.stringify(after.schedule)
  )
    return before.nextRunAt;
  return nextRun(after.schedule, now);
}
