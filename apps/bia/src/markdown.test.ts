import { describe, expect, it } from "vite-plus/test";

import { highlightCode } from "./codeHighlight";
import { codeLanguage, parseMarkdown, safeLinkUrl } from "./markdown";

describe("parseMarkdown", () => {
  it("reads what a ChatGPT-style reply uses", () => {
    const tree = parseMarkdown(
      [
        "## Plano",
        "",
        "1. **Comprar** pão",
        "2. ~~Ligar~~ para a *Ana*",
        "",
        "- [x] feito",
        "- [ ] falta",
        "",
        "| Item | Preço |",
        "| :--- | ---: |",
        "| Café | R$ 9 |",
        "",
        "```ts",
        "const total = 9;",
        "```",
        "",
        "> nota",
      ].join("\n"),
    );
    expect(tree.children.map((node) => node.type)).toEqual([
      "heading",
      "list",
      "list",
      "table",
      "code",
      "blockquote",
    ]);
    const table = tree.children[3];
    expect(table?.type === "table" ? table.align : null).toEqual(["left", "right"]);
    const tasks = tree.children[2];
    expect(tasks?.type === "list" ? tasks.children.map((item) => item.checked) : null).toEqual([
      true,
      false,
    ]);
  });

  it("keeps an unclosed code fence of a streaming reply as code", () => {
    const tree = parseMarkdown("Veja:\n\n```py\nprint('oi')");
    expect(tree.children.at(-1)).toMatchObject({ type: "code", lang: "py", value: "print('oi')" });
  });
});

describe("safeLinkUrl", () => {
  it("opens only web, mail and phone links", () => {
    expect(safeLinkUrl("https://exemplo.com/a b")).toBe("https://exemplo.com/a%20b");
    expect(safeLinkUrl("mailto:bia@example.com")).toBe("mailto:bia@example.com");
    expect(safeLinkUrl("tel:+5511999999999")).toBe("tel:+5511999999999");
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/hosts",
      "intent://x",
      "data:text/html,x",
      "relative/path",
    ]) {
      expect(safeLinkUrl(url)).toBeNull();
    }
  });
});

describe("code highlighting", () => {
  it("colors known languages and leaves the rest plain", () => {
    expect(codeLanguage("TS")).toBe("typescript");
    expect(codeLanguage("python {title}")).toBe("python");
    expect(codeLanguage("brainfuck")).toBeNull();
    const lines = highlightCode("const total = 9;\nreturn total;", codeLanguage("ts"));
    expect(lines).toHaveLength(2);
    expect(lines[0]!.map((token) => token.content).join("")).toBe("const total = 9;");
    expect(lines[0]!.some((token) => token.color !== undefined)).toBe(true);
    expect(highlightCode("a\nb", null)).toEqual([
      [{ content: "a", color: undefined }],
      [{ content: "b", color: undefined }],
    ]);
  });
});
