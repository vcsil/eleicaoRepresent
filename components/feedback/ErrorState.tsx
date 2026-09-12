export function ErrorState({
  title = "Algo deu errado",
  description = "Ocorreu um erro. Tente novamente em instantes.",
}: {
  title?: string;
  description?: string;
}) {
  return (
    <div className="rounded-lg border border-danger-bg bg-danger-bg p-6 text-center">
      <h2 className="text-base font-medium text-danger">{title}</h2>
      <p className="mt-2 text-sm text-danger/80">{description}</p>
    </div>
  );
}
