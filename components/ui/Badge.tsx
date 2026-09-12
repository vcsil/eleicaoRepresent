import type { ReactNode } from "react";

type Tone = "neutral" | "success" | "warning" | "info" | "danger" | "accent";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-muted text-foreground-muted",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  info: "bg-info-bg text-info",
  danger: "bg-danger-bg text-danger",
  accent: "bg-accent/15 text-accent-foreground",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
