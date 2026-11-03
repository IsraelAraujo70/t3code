import { expect, it } from "vite-plus/test";
import { GATE_REASON_MAX, gateAskMarkdown, gateReason } from "./gateText.ts";

const plan =
  "Audiencia: a categoria coletiva entrega so aos membros ativos da coletiva, hoje so o Israel, entao nenhum cliente precisa ser desativado (recomendado nao desativar). Alternativa opcional: desativar os 6 IDs acima e reativar exatamente esses 6 na restauracao.";
const restore =
  "Idempotente, cada passo com GET antes. 1) Esperar o leilao novo CLOSED e a fatura criada. 2) Fatura nova (GET /api/invoices filtrando por batchId): open -> PATCH. 3) Para o produto novo, GET; se status != archived, DELETE.";
const qaAsk = `Plano do leilão de QA em staging: ${plan} Restauração: ${restore}`;

it.each([
  [
    "a short ask stays whole",
    "  Leilão 42 aberto,\n termina 18:00. Teste no celular. ",
    {},
    "Leilão 42 aberto, termina 18:00. Teste no celular.",
  ],
  [
    "a long rendered template reads as its lead",
    qaAsk,
    {
      template:
        "Plano do leilão de QA em staging: {{nodes.plan.output.plan}} Restauração: {{nodes.plan.output.restorePlan}}",
    },
    "Plano do leilão de QA em staging",
  ],
  [
    "a lead too thin to stand alone falls to the title",
    `PR ${"x".repeat(200)}`,
    { template: "PR {{params.pr}}", title: "Merge to staging" },
    "Merge to staging",
  ],
  [
    "without a template, the first sentence",
    `${"Apply the plan. ".repeat(1)}${plan}`,
    {},
    "Apply the plan.",
  ],
  ["a markdown heading is the first line", `# Plano de QA\n\n${plan}`, {}, "Plano de QA"],
])("%s", (_name, ask, source, reason) => {
  expect(gateReason(ask, source)).toBe(reason);
});

it("cuts a long first sentence at a word, within two lines", () => {
  const reason = gateReason(`Plano: ${plan.replaceAll(".", ",")}`);
  expect(reason.length).toBeLessThanOrEqual(GATE_REASON_MAX);
  expect(reason.endsWith("…")).toBe(true);
  expect(`Plano: ${plan}`.startsWith(reason.slice(0, -1))).toBe(true);
});

it("lists inline numbered steps and leaves written lines alone", () => {
  expect(gateAskMarkdown(`Restauração: ${restore}`)).toBe(
    "Restauração: Idempotente, cada passo com GET antes.\n\n1. Esperar o leilao novo CLOSED e a fatura criada.\n\n2. Fatura nova (GET /api/invoices filtrando por batchId): open -> PATCH.\n\n3. Para o produto novo, GET; se status != archived, DELETE.",
  );
  expect(gateAskMarkdown("Merge?\n1) a 2) b")).toBe("Merge?\n1) a 2) b");
  expect(gateAskMarkdown("Pick 1) only")).toBe("Pick 1) only");
  expect(gateAskMarkdown("DELETE /api/products/<id>")).toBe("DELETE /api/products/\\<id>");
});
