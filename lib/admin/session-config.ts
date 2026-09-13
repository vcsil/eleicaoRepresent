/**
 * Janela de inatividade da sessão administrativa.
 *
 * ATENÇÃO: este valor precisa coincidir com o intervalo usado por
 * `check_admin_session` no banco (migration 0018). Se divergirem, o cliente
 * acha que tem mais tempo do que o servidor concede, e o administrador é
 * deslogado no meio de uma operação. Há teste de integração travando os
 * dois valores — ver tests/integration/admin-session-idle-timeout.test.ts.
 */
export const ADMIN_IDLE_TIMEOUT_SECONDS = 10 * 60;
export const ADMIN_SESSION_WARNING_SECONDS = 60;
export const ADMIN_ACTIVITY_HEARTBEAT_SECONDS = 45;

