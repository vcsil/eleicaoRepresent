// Sem "server-only": usado tanto em Server Components quanto em Client
// Components (cards/drawers de candidato). NEXT_PUBLIC_SUPABASE_URL é
// pública por definição.
export function candidatePhotoUrl(photoPath: string | null): string | null {
  if (!photoPath) return null;
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  return `${base}/storage/v1/object/public/candidate-photos/${photoPath}`;
}
