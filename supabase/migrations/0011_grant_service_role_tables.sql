-- Correção para projetos que já aplicaram 0001-0010. Continuação do fix
-- de 0010_fix_service_role_grants.sql (que corrigiu EXECUTE em funções):
-- aquele resolveu as chamadas via RPC, mas o acesso DIRETO a tabelas via
-- service_role (usado, por design, em grande parte do código — sessão e
-- log administrativo, CRUD de candidatos, cronograma, leitura de
-- métricas/eventos de segurança/desempates) continuava quebrado, porque
-- nenhuma migration jamais concedeu nada a service_role em nenhuma
-- tabela. service_role só tem o atributo BYPASSRLS (ignora *policies* de
-- RLS); ele continua sujeito à ACL normal de GRANT/REVOKE do Postgres, e
-- tabelas — diferente de funções — não recebem nenhum privilégio a
-- PUBLIC por padrão na criação.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
