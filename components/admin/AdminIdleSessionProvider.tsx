"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { renewAdminSessionAction } from "@/app/admin/actions";
import {
  ADMIN_ACTIVITY_HEARTBEAT_SECONDS,
  ADMIN_IDLE_TIMEOUT_SECONDS,
  ADMIN_SESSION_WARNING_SECONDS,
} from "@/lib/admin/session-config";
import { Button } from "@/components/ui/Button";

const CHANNEL_NAME = "admin-session-state";

/**
 * Rolagem conta como atividade: um administrador lendo uma página longa de
 * resultados com a roda do mouse estava sendo deslogado, porque só clique,
 * tecla e toque contavam.
 *
 * `wheel`, `scroll` e `touchmove` disparam dezenas de vezes por segundo —
 * daí o throttle em `registerActivity`, sem o qual cada quadro de rolagem
 * postaria uma mensagem no BroadcastChannel.
 */
const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  "pointerdown",
  "keydown",
  "touchstart",
  "touchmove",
  "wheel",
  "scroll",
];

const ACTIVITY_THROTTLE_MS = 1000;

export function AdminIdleSessionProvider({
  children,
  initialExpiresAt,
}: {
  children: ReactNode;
  initialExpiresAt: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [warning, setWarning] = useState(false);
  const expiresAtRef = useRef(new Date(initialExpiresAt).getTime());
  // Inicializa com 0 e preenche na montagem: `Date.now()` no corpo do
  // componente é chamada impura durante o render (react-hooks/purity), e é
  // reavaliada a cada render só para ter o valor descartado.
  const lastHumanActivityRef = useRef(0);
  const lastHeartbeatRef = useRef(0);
  const heartbeatPendingRef = useRef(false);
  const initialPathnameRef = useRef(true);
  const channelRef = useRef<BroadcastChannel | null>(null);

  const expire = useCallback(() => {
    channelRef.current?.postMessage({ type: "expired" });
    router.replace("/admin?reason=expired");
    router.refresh();
  }, [router]);

  const heartbeat = useCallback(async (force = false) => {
    const now = Date.now();
    if (
      heartbeatPendingRef.current ||
      (!force && now - lastHeartbeatRef.current < ADMIN_ACTIVITY_HEARTBEAT_SECONDS * 1000)
    ) {
      return;
    }
    heartbeatPendingRef.current = true;
    lastHeartbeatRef.current = now;
    try {
      const result = await renewAdminSessionAction();
      if (!result.ok) return expire();
      expiresAtRef.current = new Date(result.expiresAt).getTime();
      setWarning(false);
      channelRef.current?.postMessage({ type: "renewed", expiresAt: result.expiresAt });
    } catch {
      // Uma falha transitória não prova expiração. O relógio local continua e
      // qualquer próxima operação será novamente validada pelo servidor.
    } finally {
      heartbeatPendingRef.current = false;
    }
  }, [expire]);

  const registerActivity = useCallback(() => {
    const now = Date.now();
    // Throttle: eventos contínuos (rolagem) não precisam avançar o relógio
    // mais de uma vez por segundo.
    if (now - lastHumanActivityRef.current < ACTIVITY_THROTTLE_MS) return;
    lastHumanActivityRef.current = now;
    setWarning(false);
    channelRef.current?.postMessage({ type: "activity", at: now });
    void heartbeat();
  }, [heartbeat]);

  useEffect(() => {
    // O relógio de inatividade começa na montagem — não durante o render.
    if (lastHumanActivityRef.current === 0) lastHumanActivityRef.current = Date.now();

    const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME);
    channelRef.current = channel;
    if (channel) {
      channel.onmessage = (event: MessageEvent<{ type: string; expiresAt?: string; at?: number }>) => {
        if (event.data.type === "expired") expire();
        if (event.data.type === "activity" && event.data.at) {
          lastHumanActivityRef.current = Math.max(lastHumanActivityRef.current, event.data.at);
          setWarning(false);
        }
        if (event.data.type === "renewed" && event.data.expiresAt) {
          expiresAtRef.current = new Date(event.data.expiresAt).getTime();
          setWarning(false);
        }
      };
    }
    for (const eventName of ACTIVITY_EVENTS) {
      window.addEventListener(eventName, registerActivity, { passive: true });
    }
    const interval = window.setInterval(() => {
      const now = Date.now();
      const localIdleDeadline = lastHumanActivityRef.current + ADMIN_IDLE_TIMEOUT_SECONDS * 1000;
      const effectiveDeadline = Math.min(localIdleDeadline, expiresAtRef.current);
      if (now >= effectiveDeadline) return expire();
      setWarning(effectiveDeadline - now <= ADMIN_SESSION_WARNING_SECONDS * 1000);
    }, 1000);

    return () => {
      window.clearInterval(interval);
      for (const eventName of ACTIVITY_EVENTS) window.removeEventListener(eventName, registerActivity);
      channel?.close();
      channelRef.current = null;
    };
  }, [expire, registerActivity]);

  // Uma navegação admin concluída nasceu de interação relevante, mas prefetch não altera pathname.
  useEffect(() => {
    if (initialPathnameRef.current) {
      initialPathnameRef.current = false;
      return;
    }
    registerActivity();
  }, [pathname, registerActivity]);

  return (
    <>
      {children}
      {warning && (
        <aside
          role="alert"
          className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-border bg-surface p-4 shadow-lg"
        >
          <p className="text-sm text-foreground">Sua sessão será encerrada em breve por inatividade.</p>
          <Button className="mt-3" onClick={() => void heartbeat(true)}>
            Continuar sessão
          </Button>
        </aside>
      )}
    </>
  );
}
