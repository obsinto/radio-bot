import type { ScheduleRecord, ScheduleStatus } from "@radio-bot/shared";

type ZonedParts = {
  year: number;
  month: number;
  day: number;
};

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone
    }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeDaysOfWeek(daysOfWeek: number[]): number[] {
  return [...new Set(daysOfWeek)]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
}

export function isValidTimeOfDay(timeOfDay: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(timeOfDay);
}

export function nextRunAtForSchedule(
  input: Pick<ScheduleRecord, "timezone" | "timeOfDay" | "daysOfWeek" | "status">,
  from = new Date()
): string | null {
  if (input.status !== "enabled") {
    return null;
  }

  const daysOfWeek = normalizeDaysOfWeek(input.daysOfWeek);
  if (daysOfWeek.length === 0 || !isValidTimeOfDay(input.timeOfDay) || !isValidTimezone(input.timezone)) {
    return null;
  }

  const [hour, minute] = input.timeOfDay.split(":").map(Number);
  const currentDate = zonedDateParts(from, input.timezone);
  const baseDate = Date.UTC(currentDate.year, currentDate.month - 1, currentDate.day);

  for (let dayOffset = 0; dayOffset <= 14; dayOffset += 1) {
    const localDate = new Date(baseDate);
    localDate.setUTCDate(localDate.getUTCDate() + dayOffset);

    if (!daysOfWeek.includes(localDate.getUTCDay())) {
      continue;
    }

    const candidate = zonedDateTimeToUtc(
      localDate.getUTCFullYear(),
      localDate.getUTCMonth() + 1,
      localDate.getUTCDate(),
      hour,
      minute,
      input.timezone
    );

    if (candidate.getTime() > from.getTime() + 999) {
      return candidate.toISOString();
    }
  }

  return null;
}

export function normalizeScheduleStatus(value: unknown): ScheduleStatus {
  return value === "disabled" ? "disabled" : "enabled";
}

function zonedDateParts(date: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return {
    year: Number(parts.find((part) => part.type === "year")?.value),
    month: Number(parts.find((part) => part.type === "month")?.value),
    day: Number(parts.find((part) => part.type === "day")?.value)
  };
}

function zonedDateTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  let utcTimestamp = Date.UTC(year, month - 1, day, hour, minute, 0);

  for (let index = 0; index < 2; index += 1) {
    const offset = timeZoneOffsetMs(new Date(utcTimestamp), timezone);
    utcTimestamp = Date.UTC(year, month - 1, day, hour, minute, 0) - offset;
  }

  return new Date(utcTimestamp);
}

function timeZoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const asUtc = Date.UTC(
    value("year"),
    value("month") - 1,
    value("day"),
    value("hour"),
    value("minute"),
    value("second")
  );

  return asUtc - date.getTime();
}
