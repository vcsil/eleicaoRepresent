-- Funções centrais da votação. Ambas SECURITY DEFINER, chamadas apenas pelo
-- cliente service_role a partir de Route Handlers (nunca expostas a anon).

-- =========================================================================
-- validate_voter — seções 21-24. Nunca revela detalhes que permitam
-- enumeração (seção 23); a única exceção documentada é "já votou".
-- =========================================================================
create or replace function public.validate_voter(
  p_election_id uuid,
  p_registration_number text,
  p_full_name text,
  p_ip_hash text default null,
  p_user_agent_summary text default null,
  p_session_ttl_seconds int default 1200
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_election elections%rowtype;
  v_status text;
  v_voter voters%rowtype;
  v_already_voted boolean;
  v_token text;
  v_token_hash text;
  v_expires_at timestamptz;
begin
  select * into v_election from elections where id = p_election_id;
  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  v_status := compute_election_status(p_election_id);
  if v_status <> 'votacao_em_andamento' and v_status <> 'votacao_desempate' then
    return jsonb_build_object('status', 'voting_not_open');
  end if;

  select * into v_voter
  from voters
  where registration_number = trim(p_registration_number);

  if not found then
    return jsonb_build_object('status', 'invalid');
  end if;

  if v_voter.normalized_name <> normalize_name(p_full_name) then
    return jsonb_build_object('status', 'invalid');
  end if;

  if not v_voter.active then
    return jsonb_build_object('status', 'invalid');
  end if;

  select exists(
    select 1 from audit_vote_links al
    where al.election_id = p_election_id and al.voter_id = v_voter.id
  ) into v_already_voted;

  if v_already_voted then
    return jsonb_build_object('status', 'already_voted');
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  v_token_hash := encode(digest(v_token, 'sha256'), 'hex');
  v_expires_at := now() + make_interval(secs => p_session_ttl_seconds);

  -- Invalida sessões anteriores não consumidas do mesmo eleitor para essa
  -- eleição (evita acumular tokens válidos de tentativas anteriores).
  update vote_sessions
  set consumed_at = now()
  where voter_id = v_voter.id and election_id = p_election_id and consumed_at is null;

  insert into vote_sessions (election_id, voter_id, token_hash, expires_at, ip_hash, user_agent_summary)
  values (p_election_id, v_voter.id, v_token_hash, v_expires_at, p_ip_hash, p_user_agent_summary);

  return jsonb_build_object(
    'status', 'ok',
    'token', v_token,
    'expires_at', v_expires_at
  );
end;
$$;

revoke all on function public.validate_voter(uuid, text, text, text, text, int) from public, anon, authenticated;

-- =========================================================================
-- cast_ballot — seções 26-40, 86. Transação atômica única; nenhum total é
-- aceito do cliente, tudo é recontado a partir das quantidades individuais
-- enviadas por posição/candidato.
--
-- Payload esperado (p_payload):
-- {
--   "positions": [
--     {
--       "position_id": "uuid",
--       "allocations": [
--         { "candidate_id": "uuid|null", "is_null_vote": bool, "quantity": int }
--       ]
--     }
--   ]
-- }
-- =========================================================================
create or replace function public.cast_ballot(
  p_session_token text,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_token_hash text;
  v_session vote_sessions%rowtype;
  v_voter voters%rowtype;
  v_election elections%rowtype;
  v_status text;
  v_ballot_id uuid;
  v_required_positions uuid[];
  v_position_id uuid;
  v_votes_per_voter int;
  v_position_payload jsonb;
  v_allocation jsonb;
  v_sum int;
  v_slot int;
  v_quantity int;
  v_quantity_numeric numeric;
  v_candidate_id uuid;
  v_is_null boolean;
  v_seen_keys text[];
  v_key text;
begin
  if p_session_token is null or length(p_session_token) < 32 then
    raise exception 'SESSION_INVALID';
  end if;

  v_token_hash := encode(digest(p_session_token, 'sha256'), 'hex');

  select * into v_session from vote_sessions where token_hash = v_token_hash for update;
  if not found then
    raise exception 'SESSION_INVALID';
  end if;
  if v_session.consumed_at is not null then
    raise exception 'SESSION_INVALID';
  end if;
  if v_session.expires_at < now() then
    raise exception 'SESSION_EXPIRED';
  end if;

  select * into v_voter from voters where id = v_session.voter_id for update;
  if not found or not v_voter.active then
    raise exception 'VOTER_INACTIVE';
  end if;

  select * into v_election from elections where id = v_session.election_id;
  if not found then
    raise exception 'ELECTION_NOT_FOUND';
  end if;

  v_status := compute_election_status(v_session.election_id);
  if v_status <> 'votacao_em_andamento' and v_status <> 'votacao_desempate' then
    raise exception 'VOTING_CLOSED';
  end if;

  if exists(
    select 1 from audit_vote_links al
    where al.election_id = v_session.election_id and al.voter_id = v_voter.id
  ) then
    raise exception 'ALREADY_VOTED';
  end if;

  if p_payload is null or jsonb_typeof(p_payload -> 'positions') <> 'array'
     or (p_payload - 'positions') <> '{}'::jsonb then
    raise exception 'INVALID_PAYLOAD';
  end if;

  -- Posições obrigatórias: todas as ativas numa eleição geral; apenas a
  -- posição em disputa numa eleição de desempate.
  if v_election.type = 'runoff' then
    v_required_positions := array[v_election.runoff_position_id];
  else
    select array_agg(id) into v_required_positions from positions where active = true;
  end if;

  if jsonb_array_length(p_payload -> 'positions') <> array_length(v_required_positions, 1) then
    raise exception 'INVALID_PAYLOAD';
  end if;

  insert into ballots (election_id, submitted_at)
  values (v_session.election_id, now())
  returning id into v_ballot_id;

  foreach v_position_id in array v_required_positions loop
    select p.votes_per_voter into v_votes_per_voter from positions p where p.id = v_position_id;
    if v_election.type = 'runoff' then
      v_votes_per_voter := v_election.runoff_votes_per_voter;
    end if;

    select value into v_position_payload
    from jsonb_array_elements(p_payload -> 'positions') as value
    where (value ->> 'position_id')::uuid = v_position_id;

    if v_position_payload is null
       or (v_position_payload - 'position_id' - 'allocations') <> '{}'::jsonb then
      raise exception 'INVALID_PAYLOAD';
    end if;

    if jsonb_typeof(v_position_payload -> 'allocations') <> 'array'
       or jsonb_array_length(v_position_payload -> 'allocations') = 0 then
      raise exception 'INVALID_PAYLOAD';
    end if;

    v_sum := 0;
    v_slot := 0;
    v_seen_keys := '{}';

    for v_allocation in select * from jsonb_array_elements(v_position_payload -> 'allocations') loop
      if not (v_allocation ? 'quantity') or jsonb_typeof(v_allocation -> 'quantity') <> 'number'
         or (v_allocation - 'candidate_id' - 'is_null_vote' - 'quantity') <> '{}'::jsonb then
        raise exception 'INVALID_PAYLOAD';
      end if;

      -- Cast para numeric primeiro: um cast direto para ::int falha com um
      -- erro bruto do Postgres (não a exceção INVALID_PAYLOAD) para valores
      -- como 1.5. numeric aceita qualquer number do JSON sem erro.
      v_quantity_numeric := (v_allocation ->> 'quantity')::numeric;

      if v_quantity_numeric <> trunc(v_quantity_numeric) or v_quantity_numeric < 0 then
        raise exception 'INVALID_PAYLOAD';
      end if;

      v_quantity := v_quantity_numeric::int;
      v_is_null := coalesce((v_allocation ->> 'is_null_vote')::boolean, false);

      if v_quantity = 0 then
        continue;
      end if;

      if v_is_null then
        v_candidate_id := null;
        v_key := 'null';
      else
        if not (v_allocation ? 'candidate_id') or v_allocation ->> 'candidate_id' is null then
          raise exception 'INVALID_PAYLOAD';
        end if;
        v_candidate_id := (v_allocation ->> 'candidate_id')::uuid;
        v_key := v_candidate_id::text;

        if v_election.type = 'runoff' then
          if not exists(
            select 1 from runoff_candidates rc
            where rc.runoff_election_id = v_session.election_id and rc.candidate_id = v_candidate_id
          ) then
            raise exception 'INVALID_CANDIDATE';
          end if;
        else
          if not exists(
            select 1 from candidate_positions cp
            join candidates c on c.id = cp.candidate_id
            where cp.position_id = v_position_id and cp.candidate_id = v_candidate_id and c.active = true
          ) then
            raise exception 'INVALID_CANDIDATE';
          end if;
        end if;
      end if;

      if v_key = any(v_seen_keys) then
        raise exception 'INVALID_PAYLOAD';
      end if;
      v_seen_keys := array_append(v_seen_keys, v_key);

      v_sum := v_sum + v_quantity;
      if v_sum > v_votes_per_voter then
        raise exception 'INVALID_VOTE_SUM';
      end if;

      for i in 1..v_quantity loop
        v_slot := v_slot + 1;
        insert into ballot_choices (ballot_id, position_id, candidate_id, is_null_vote, vote_slot)
        values (v_ballot_id, v_position_id, v_candidate_id, v_is_null, v_slot);
      end loop;
    end loop;

    if v_sum <> v_votes_per_voter then
      raise exception 'INVALID_VOTE_SUM';
    end if;
  end loop;

  insert into audit_vote_links (election_id, voter_id, ballot_id)
  values (v_session.election_id, v_voter.id, v_ballot_id);

  update voters set has_voted = true, voted_at = now() where id = v_voter.id;
  update vote_sessions set consumed_at = now() where id = v_session.id;

  return v_ballot_id;
end;
$$;

revoke all on function public.cast_ballot(text, jsonb) from public, anon, authenticated;
