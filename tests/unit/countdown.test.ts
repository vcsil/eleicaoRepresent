import { describe, expect, it } from "vitest";
import { getRemaining } from "@/lib/election/countdown";

/**
 * O hydration mismatch da home nasceu de `getRemaining` ler `Date.now()`
 * durante o render: servidor e cliente calculavam com relógios diferentes
 * e os segundos divergiam pelo tempo de rede + hidratação. A função agora
 * recebe o instante, e estes testes existem para que ela nunca volte a
 * depender de estado global.
 */

const TARGET = "2026-09-19T18:00:00.000Z";
const at = (iso: string) => new Date(iso).getTime();

describe("getRemaining", () => {
  it("é determinística — mesmas entradas, mesma saída", () => {
    const now = at("2026-09-19T17:59:14.000Z");
    expect(getRemaining(TARGET, now)).toEqual(getRemaining(TARGET, now));
  });

  it("servidor e cliente com o MESMO snapshot produzem o mesmo resultado", () => {
    // É exatamente esta propriedade que elimina o mismatch: o primeiro
    // render dos dois lados parte do mesmo instante.
    const serverNow = at("2026-09-19T17:59:14.000Z");
    const noServidor = getRemaining(TARGET, serverNow);
    const noCliente = getRemaining(TARGET, serverNow);
    expect(noCliente).toEqual(noServidor);
    expect(noCliente.seconds).toBe(46);
  });

  it("snapshots diferentes divergem — é o bug original, reproduzido", () => {
    // Documenta a causa: 6 segundos entre SSR e hidratação davam 46 vs 40.
    const noServidor = getRemaining(TARGET, at("2026-09-19T17:59:14.000Z"));
    const noCliente = getRemaining(TARGET, at("2026-09-19T17:59:20.000Z"));
    expect(noServidor.seconds).toBe(46);
    expect(noCliente.seconds).toBe(40);
    expect(noCliente).not.toEqual(noServidor);
  });

  it("decompõe dias, horas, minutos e segundos", () => {
    const now = at("2026-09-17T14:30:45.000Z"); // 2d 3h 29min 15s antes
    expect(getRemaining(TARGET, now)).toEqual({
      days: 2,
      hours: 3,
      minutes: 29,
      seconds: 15,
      done: false,
    });
  });

  it("marca done exatamente no alvo", () => {
    expect(getRemaining(TARGET, at(TARGET))).toEqual({
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      done: true,
    });
  });

  it("não devolve valores negativos depois do prazo", () => {
    const remaining = getRemaining(TARGET, at("2026-09-20T00:00:00.000Z"));
    expect(remaining.done).toBe(true);
    for (const value of [remaining.days, remaining.hours, remaining.minutes, remaining.seconds]) {
      expect(value).toBe(0);
    }
  });

  it("o offset do servidor corrige relógio desregulado do visitante", () => {
    // O componente conta com Date.now() + (serverNow - clientNow). Quem
    // está 10 minutos adiantado precisa ver o MESMO tempo restante de quem
    // está com a hora certa.
    const serverNow = at("2026-09-19T17:00:00.000Z");
    const certo = getRemaining(TARGET, serverNow);

    const clienteAdiantado = at("2026-09-19T17:10:00.000Z");
    const offset = serverNow - clienteAdiantado;
    const corrigido = getRemaining(TARGET, clienteAdiantado + offset);

    expect(corrigido).toEqual(certo);
    expect(corrigido.minutes).toBe(0);
    expect(corrigido.hours).toBe(1);
  });
});
