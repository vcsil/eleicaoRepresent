import "server-only";
import { createServiceClient } from "@/lib/supabase/service";
import {
  buildDailySiteAccessSeries,
  getCalendarDateInTimeZone,
  getSeriesStartDate,
  type DailySiteAccessStat,
  type SiteAccessRow,
} from "@/lib/admin/site-access-series";

const SITE_TIME_ZONE = "America/Sao_Paulo";

export async function getDailySiteAccessStats(
  numberOfDays = 30,
): Promise<DailySiteAccessStat[]> {
  const today = getCalendarDateInTimeZone(new Date(), SITE_TIME_ZONE);
  const startDate = getSeriesStartDate(today, numberOfDays);
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("site_access_stats")
    .select("day, views")
    .gte("day", startDate)
    .lte("day", today);

  if (error) throw error;
  return buildDailySiteAccessSeries((data ?? []) as SiteAccessRow[], today, numberOfDays);
}
