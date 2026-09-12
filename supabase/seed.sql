-- Dados iniciais: eleição principal, cronograma oficial (seção 7) e os 6
-- cargos com as 13 vagas da Comissão (seção 8). Pode ser reaplicado com
-- segurança (idempotente via ON CONFLICT) em um projeto recém-criado.

insert into elections (id, type, name)
values ('00000000-0000-0000-0000-000000000001', 'general', 'Eleição da Comissão de Formatura — Turma 36')
on conflict (id) do nothing;

insert into positions (slug, name, vacancies, votes_per_voter, seat_labels, description, responsibilities, profile, display_order)
values
  ('presidente', 'Presidente', 1, 1, null,
   'Lidera a Comissão de Formatura, conduzindo reuniões e representando a turma nas decisões e negociações.',
   'Convocar e conduzir reuniões; coordenar tarefas; representar a Comissão; participar de negociações; acompanhar decisões; auxiliar na resolução de impasses; manter comunicação com os membros.',
   'Liderança; responsabilidade; organização; firmeza; capacidade de decisão; capacidade de ouvir; imparcialidade.',
   1),
  ('vice_presidente', 'Vice-Presidente', 1, 1, null,
   'Auxilia o Presidente e assume a condução da Comissão quando necessário.',
   'Auxiliar o Presidente; acompanhar atividades; substituir o Presidente quando necessário; auxiliar na comunicação; participar de decisões; auxiliar na resolução de conflitos.',
   'Liderança; responsabilidade; organização; iniciativa; capacidade de decisão; perfil conciliador.',
   2),
  ('tesouraria', 'Tesouraria', 2, 2, array['Primeiro Tesoureiro', 'Segundo Tesoureiro'],
   'Responsável pelo controle financeiro da Comissão, com transparência nas receitas e despesas.',
   'Acompanhamento financeiro; organização dos registros; acompanhamento de receitas e despesas; apresentação de informações financeiras; planejamento financeiro; controle de compromissos e prazos; colaboração com os demais membros.',
   'Organização; responsabilidade; transparência; atenção; facilidade com números e documentos; confiança.',
   3),
  ('secretaria', 'Secretaria', 2, 2, array['Primeiro Secretário', 'Segundo Secretário'],
   'Organiza pautas, atas e documentos da Comissão, mantendo o registro formal das decisões.',
   'Elaboração de pautas; registro de atas; organização de documentos; arquivo digital; acompanhamento de prazos; organização de informações; registro de decisões.',
   'Organização; atenção aos detalhes; responsabilidade; comprometimento.',
   4),
  ('marketing', 'Marketing', 3, 3, null,
   'Cuida da comunicação, divulgação e engajamento da turma nas ações da Comissão.',
   'Comunicação; materiais de divulgação; campanhas; estratégias de engajamento; mobilização da turma; criatividade; identidade visual; apoio às ações da Comissão.',
   'Criatividade; iniciativa; comunicação; organização; proatividade; trabalho em equipe.',
   5),
  ('eventos', 'Eventos', 4, 4, null,
   'Planeja e executa eventos e ações de arrecadação e integração da turma.',
   'Planejamento de eventos; organização; integração; ações de arrecadação; contato com fornecedores; participação em estratégias de engajamento; execução de atividades.',
   'Organização; criatividade; iniciativa; comunicação; proatividade; capacidade de trabalhar em equipe.',
   6)
on conflict (slug) do nothing;

insert into election_phases (election_id, phase_key, label, starts_on, ends_on, display_order)
values
  ('00000000-0000-0000-0000-000000000001', 'edital', 'Publicação do edital', '2026-09-11', '2026-09-11', 1),
  ('00000000-0000-0000-0000-000000000001', 'candidaturas', 'Período de candidatura', '2026-09-12', '2026-09-15', 2),
  ('00000000-0000-0000-0000-000000000001', 'divulgacao_candidaturas', 'Divulgação das candidaturas', '2026-09-16', '2026-09-16', 3),
  ('00000000-0000-0000-0000-000000000001', 'apresentacao', 'Apresentação/defesa dos candidatos', '2026-09-18', '2026-09-18', 4),
  ('00000000-0000-0000-0000-000000000001', 'envio_videos', 'Envio dos vídeos', '2026-09-18', '2026-09-18', 5),
  ('00000000-0000-0000-0000-000000000001', 'votacao', 'Período de votação', '2026-09-19', '2026-09-23', 6),
  ('00000000-0000-0000-0000-000000000001', 'apuracao', 'Apuração', '2026-09-24', '2026-09-24', 7),
  ('00000000-0000-0000-0000-000000000001', 'divulgacao_resultados', 'Divulgação dos resultados', '2026-09-24', '2026-09-24', 8)
on conflict (election_id, phase_key) do nothing;
