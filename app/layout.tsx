import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Comissão de Formatura — Turma 36",
    template: "%s | Comissão de Formatura — Turma 36",
  },
  description:
    "Eleição da Comissão de Formatura da Turma 36 de Medicina — UniEVANGÉLICA: cronograma, candidatos e votação.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR" className={`${inter.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
