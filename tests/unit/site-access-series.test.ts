import { describe, expect, it } from "vitest";
import {
  buildDailySiteAccessSeries,
  getCalendarDateInTimeZone,
} from "@/lib/admin/site-access-series";

describe("buildDailySiteAccessSeries", () => {
  it("produz exatamente 30 dias em ordem, incluindo hoje", () => {
    const series = buildDailySiteAccessSeries([], "2026-09-13");

    expect(series).toHaveLength(30);
    expect(series[0]).toEqual({ date: "2026-08-15", views: 0 });
    expect(series.at(-1)).toEqual({ date: "2026-09-13", views: 0 });
    expect(series.map(({ date }) => date)).toEqual(
      [...series.map(({ date }) => date)].sort(),
    );
  });

  it("soma todos os paths no mesmo dia e preenche dias ausentes com zero", () => {
    const series = buildDailySiteAccessSeries(
      [
        { day: "2026-09-11", views: 20 },
        { day: "2026-09-13", views: 25 },
        { day: "2026-09-13", views: "10" },
        { day: "2026-09-13", views: 5 },
      ],
      "2026-09-13",
    );

    expect(series.find(({ date }) => date === "2026-09-11")?.views).toBe(20);
    expect(series.find(({ date }) => date === "2026-09-12")?.views).toBe(0);
    expect(series.find(({ date }) => date === "2026-09-13")?.views).toBe(40);
  });

  it("ignora registros fora do limite temporal e valores inválidos", () => {
    const series = buildDailySiteAccessSeries(
      [
        { day: "2026-08-14", views: 99 },
        { day: "2026-08-15", views: 3 },
        { day: "2026-09-13", views: Number.NaN },
        { day: "2026-09-14", views: 99 },
      ],
      "2026-09-13",
    );

    expect(series.reduce((sum, point) => sum + point.views, 0)).toBe(3);
  });

  it("trata datas como calendário e atravessa mês e ano sem deslocamento", () => {
    const series = buildDailySiteAccessSeries([{ day: "2025-12-31", views: 7 }], "2026-01-01", 2);

    expect(series).toEqual([
      { date: "2025-12-31", views: 7 },
      { date: "2026-01-01", views: 0 },
    ]);
  });
});

describe("getCalendarDateInTimeZone", () => {
  it("usa o dia civil de São Paulo, não o dia UTC", () => {
    const instant = new Date("2026-09-13T01:30:00.000Z");
    expect(getCalendarDateInTimeZone(instant, "America/Sao_Paulo")).toBe("2026-09-12");
  });
});
