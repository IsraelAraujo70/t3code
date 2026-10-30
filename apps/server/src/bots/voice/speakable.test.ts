import { assert, describe, it } from "@effect/vitest";

import { speakable } from "./speakable.ts";

const standIns = { codeBlock: "[code]", table: "[table]", link: "[link]", code: "[cmd]" };

describe("speakable", () => {
  it.each([
    [
      "plain text stays as it is",
      "Oi. Tudo certo.\n\nOutro parágrafo.",
      "Oi. Tudo certo.\n\nOutro parágrafo.",
    ],
    [
      "list items become sentences of the paragraph",
      "Resumo:\n- Saiu de Lisboa\n- Chegou na Bahia.\n1) Missa",
      "Resumo: Saiu de Lisboa. Chegou na Bahia. Missa.",
    ],
    [
      "a heading and a bold-only line become sentences",
      "## Status\nPronto\n\n**Aberto**\n- nada",
      "Status. Pronto\n\nAberto. nada.",
    ],
    [
      "emphasis is dropped, snake_case is kept",
      "O **build** passa, *agora* ~~não~~ e __já__; fica foo_bar_baz.",
      "O build passa, agora não e já; fica foo_bar_baz.",
    ],
    [
      "a code block becomes one stand-in, keeping what follows",
      "Veja:\n```ts\nconst a = 1;\n\nawait b();\n```\nDepois.",
      "Veja: [code] Depois.",
    ],
    [
      "a table becomes one stand-in",
      "Antes.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nDepois.",
      "Antes.\n\n[table]\n\nDepois.",
    ],
    [
      "links keep their text and bare URLs get the stand-in",
      "Em [variáveis](https://x.dev/env) e https://x.dev/a?b=1, ou <https://y.dev>.",
      "Em variáveis e [link], ou [link].",
    ],
    [
      "short inline code is said, a long path by its name, other long code not at all",
      "Rode `pnpm run deploy` em `apps/backoffice-api/src/clients/ssh2-sftp.client.ts` com `curl -fsSL https://example.com/install.sh | sh`.",
      "Rode pnpm run deploy em ssh2-sftp.client.ts com [cmd].",
    ],
    [
      "a table without outer pipes becomes one stand-in",
      "Antes.\n\na | b\n--- | ---\n1 | 2\n\nDepois.",
      "Antes.\n\n[table]\n\nDepois.",
    ],
    [
      "a year opening a sentence stays",
      "2026. foi um ano bom.\n\n1. Primeiro",
      "2026. foi um ano bom.\n\nPrimeiro.",
    ],
    [
      "a link or URL with parentheses goes whole, and double underscores in a name stay",
      "Veja [artigo](https://x.org/wiki/F_(m)) e https://x.org/wiki/G_(n). Use foo__bar__baz.",
      "Veja artigo e [link]. Use foo__bar__baz.",
    ],
    ["emoji and rules are dropped", "Feito 🎉✅\n\n---\n\n> citado", "Feito\n\ncitado"],
  ])("%s", (_, reply, spoken) => {
    assert.strictEqual(speakable(reply, standIns), spoken);
  });
});
