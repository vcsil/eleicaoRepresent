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
const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = ["pointerdown", "keydown", "touchstart"];

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
  const lastHumanActivityRef = useRef(Date.now());
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
    lastHumanActivityRef.current = Date.now();
    setWarning(false);
    channelRef.current?.postMessage({ type: "activity", at: lastHumanActivityRef.current });
    void heartbeat();
  }, [heartbeat]);

  useEffect(() => {
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
