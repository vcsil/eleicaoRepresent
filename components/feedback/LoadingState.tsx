export function LoadingState({ label = "Carregando..." }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-foreground-muted">
      <span
        className="h-8 w-8 animate-spin rounded-full border-2 border-border border-t-primary"
        aria-hidden="true"
      />
      <p className="text-sm">{label}</p>
    </div>
  );
}
