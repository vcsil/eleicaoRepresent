import { EmptyState } from "@/components/feedback/EmptyState";
import { Button } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-6 px-4 text-center">
      <EmptyState
        title="Página não encontrada"
        description="O conteúdo que você procura não existe ou foi movido."
        action={<Button href="/">Voltar ao início</Button>}
      />
    </div>
  );
}
