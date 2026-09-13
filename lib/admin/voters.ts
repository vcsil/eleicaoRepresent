import "server-only";
import { createServiceClient } from "@/lib/supabase/service";

export type AdminVoter = {
  id: string;
  registration_number: string;
  full_name: string;
  active: boolean;
};

/**
 * Lista de eleitores para o painel.
 *
 * NÃO traz `has_voted` nem `voted_at`: a tela serve para conferir a lista
 * habilitada, e quem já votou não é informação necessária para isso. O
 * andamento da votação aparece como percentual agregado no painel, sem
 * identificar ninguém.
 */
export async function getVoters(): Promise<AdminVoter[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("voters")
    .select("id, registration_number, full_name, active")
    .order("full_name", { ascending: true });

  if (error) throw error;
  return (data ?? []) as AdminVoter[];
}

/** Matrícula → nome atual, para o preview distinguir novo de já cadastrado. */
export async function getExistingRegistrations(
  registrationNumbers: string[],
): Promise<Map<string, string>> {
  if (registrationNumbers.length === 0) return new Map();

  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("voters")
    .select("registration_number, full_name")
    .in("registration_number", registrationNumbers);

  if (error) throw error;

  return new Map(
    ((data ?? []) as { registration_number: string; full_name: string }[]).map((row) => [
      row.registration_number,
      row.full_name,
    ]),
  );
}
