"use server";

import { revalidatePath } from "next/cache";
import { scheduleUpdateSchema } from "@/lib/validation/schemas";
import { createServiceClient } from "@/lib/supabase/service";
import { logAdminAction } from "@/lib/admin/audit-log";

export type ScheduleFormState = { error: string | null; success?: boolean };

export async function updatePhaseAction(
  _prevState: ScheduleFormState,
  formData: FormData,
): Promise<ScheduleFormState> {
  const electionId = formData.get("election_id");
  const parsed = scheduleUpdateSchema.safeParse({
    phase_key: formData.get("phase_key"),
    starts_on: formData.get("starts_on"),
    ends_on: formData.get("ends_on"),
    start_time: formData.get("start_time"),
    end_time: formData.get("end_time"),
  });

  if (typeof electionId !== "string" || !parsed.success) {
    return { error: "Dados inválidos. Revise as datas e horários informados." };
  }

  if (parsed.data.ends_on < parsed.data.starts_on) {
    return { error: "A data final não pode ser anterior à data inicial." };
  }

  const supabase = createServiceClient();
  const { error } = await supabase
    .from("election_phases")
    .update({
      starts_on: parsed.data.starts_on,
      ends_on: parsed.data.ends_on,
      start_time: parsed.data.start_time,
      end_time: parsed.data.end_time,
      time_configured: true,
    })
    .eq("election_id", electionId)
    .eq("phase_key", parsed.data.phase_key);

  if (error) {
    return { error: "Não foi possível salvar o cronograma." };
  }

  await logAdminAction("SCHEDULE_UPDATED", { electionId, ...parsed.data });

  revalidatePath("/admin/cronograma");
  revalidatePath("/");
  return { error: null, success: true };
}
