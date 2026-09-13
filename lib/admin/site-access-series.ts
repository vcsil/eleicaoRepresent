export type DailySiteAccessStat = {
  date: string;
  views: number;
};

export type SiteAccessRow = {
  day: string;
  views: number | string | null;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function shiftCalendarDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Produz uma série contínua de datas civis, sem interpretar `date` como
 * timestamp. Assim, o browser nunca pode deslocar um dia por causa do fuso.
 */
export function buildDailySiteAccessSeries(
  rows: readonly SiteAccessRow[],
  today: string,
  numberOfDays = 30,
): DailySiteAccessStat[] {
  if (!ISO_DATE_PATTERN.test(today)) throw new Error("today must use YYYY-MM-DD");
  if (!Number.isInteger(numberOfDays) || numberOfDays < 1) {
    throw new Error("numberOfDays must be a positive integer");
  }

  const startDate = shiftCalendarDate(today, -(numberOfDays - 1));
  const totals = new Map<string, number>();

  for (const row of rows) {
    if (!ISO_DATE_PATTERN.test(row.day) || row.day < startDate || row.day > today) continue;
    const parsedViews = Number(row.views);
    const views = Number.isFinite(parsedViews) && parsedViews > 0 ? parsedViews : 0;
    totals.set(row.day, (totals.get(row.day) ?? 0) + views);
  }

  return Array.from({ length: numberOfDays }, (_, index) => {
    const date = shiftCalendarDate(startDate, index);
    return { date, views: totals.get(date) ?? 0 };
  });
}

export function getCalendarDateInTimeZone(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function getSeriesStartDate(today: string, numberOfDays: number): string {
  return shiftCalendarDate(today, -(numberOfDays - 1));
}
