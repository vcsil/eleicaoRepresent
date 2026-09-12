-- Extensões necessárias:
--   pgcrypto: gen_random_bytes()/digest() para tokens de sessão e hashes de IP.
--   unaccent: normalização de nomes (seção 22 do documento técnico).
create extension if not exists pgcrypto with schema extensions;
create extension if not exists unaccent with schema extensions;
