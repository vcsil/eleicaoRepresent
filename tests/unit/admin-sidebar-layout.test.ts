import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sidebarSource = readFileSync(
  new URL("../../components/admin/AdminSidebar.tsx", import.meta.url),
  "utf8",
);

describe("layout da sidebar administrativa", () => {
  it("mantém a navegação lateral visível e rolável somente no desktop", () => {
    const desktopAside = sidebarSource.match(/<aside className="([^"]+)"/);

    expect(desktopAside?.[1]).toContain("hidden");
    expect(desktopAside?.[1]).toContain("lg:sticky");
    expect(desktopAside?.[1]).toContain("lg:top-0");
    expect(desktopAside?.[1]).toContain("lg:max-h-dvh");
    expect(desktopAside?.[1]).toContain("lg:self-start");
    expect(desktopAside?.[1]).toContain("lg:overflow-y-auto");
  });
});
