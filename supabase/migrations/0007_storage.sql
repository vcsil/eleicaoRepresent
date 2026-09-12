-- Bucket de fotos dos candidatos (seção 19/66). Upload é feito apenas pelo
-- service_role (rotas administrativas); leitura pública precisa de policy
-- explícita mesmo em bucket marcado como público.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('candidate-photos', 'candidate-photos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

create policy candidate_photos_public_read on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'candidate-photos');
