"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/feedback/ErrorState";
import { Button } from "@/components/ui/Button";

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md flex-col items-center justify-center gap-6 px-4 py-16 text-center">
      <ErrorState />
      <Button onClick={reset} variant="secondary">
        Tentar novamente
      </Button>
    </div>
  );
}
