import { setStringAsync } from "expo-clipboard";
import { Image } from "expo-image";
import type { PhrasingContent, RootContent, Table } from "mdast";
import { memo, useMemo, useState, type ReactNode } from "react";
import { Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { highlightCode } from "./codeHighlight";
import { codeLanguage, parseMarkdown, safeLinkUrl } from "./markdown";
import type { OpenImage } from "./MessageBubble";
import { colors, fontSize } from "./theme";

const MONO = Platform.OS === "ios" ? "Menlo" : "monospace";

/** Nodes of one parse keep their source offsets, which stay put while a reply streams on. */
const nodeKey = (node: { readonly position?: { readonly start: { readonly offset?: number } } }) =>
  String(node.position?.start.offset);

function Inline(props: { readonly nodes: ReadonlyArray<PhrasingContent> }): ReactNode {
  return props.nodes.map((node) => {
    const key = nodeKey(node);
    switch (node.type) {
      case "text":
        return node.value;
      case "strong":
        return (
          <Text key={key} style={styles.strong}>
            <Inline nodes={node.children} />
          </Text>
        );
      case "emphasis":
        return (
          <Text key={key} style={styles.emphasis}>
            <Inline nodes={node.children} />
          </Text>
        );
      case "delete":
        return (
          <Text key={key} style={styles.delete}>
            <Inline nodes={node.children} />
          </Text>
        );
      case "inlineCode":
        return (
          <Text key={key} style={styles.inlineCode}>
            {node.value}
          </Text>
        );
      case "link": {
        const url = safeLinkUrl(node.url);
        return url === null ? (
          <Inline key={key} nodes={node.children} />
        ) : (
          <Text key={key} style={styles.link} onPress={() => void Linking.openURL(url)}>
            <Inline nodes={node.children} />
          </Text>
        );
      }
      case "break":
        return "\n";
      case "image":
        return node.alt ? `[${node.alt}]` : "";
      case "html":
        return node.value;
      case "footnoteReference":
        return `[${node.label ?? node.identifier}]`;
      default:
        return null;
    }
  });
}

function CodeBlock(props: { readonly code: string; readonly lang: string | null | undefined }) {
  const language = codeLanguage(props.lang);
  const lines = useMemo(() => highlightCode(props.code, language), [props.code, language]);
  const [copied, setCopied] = useState(false);
  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHeader}>
        <Text style={styles.codeLanguage}>{props.lang?.trim() || "código"}</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copiar código"
          hitSlop={10}
          onPress={() => {
            void setStringAsync(props.code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <Text style={styles.codeCopy}>{copied ? "Copiado ✓" : "Copiar"}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <Text selectable style={styles.code}>
          {lines.map((line, row) => (
            <Text key={row}>
              {line.map((token, column) =>
                token.color === undefined ? (
                  token.content
                ) : (
                  <Text key={column} style={{ color: token.color }}>
                    {token.content}
                  </Text>
                ),
              )}
              {row < lines.length - 1 ? "\n" : null}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
}

function TableBlock(props: { readonly table: Table }) {
  const align = props.table.align ?? [];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator style={styles.tableScroll}>
      <View style={styles.table}>
        {props.table.children.map((row, rowIndex) => (
          <View key={nodeKey(row)} style={[styles.tableRow, rowIndex === 0 && styles.tableHeader]}>
            {row.children.map((cell, cellIndex) => (
              <View
                key={nodeKey(cell)}
                style={[styles.tableCell, cellIndex > 0 && styles.tableCellDivider]}
              >
                <Text
                  selectable
                  style={[
                    styles.tableText,
                    rowIndex === 0 && styles.strong,
                    {
                      textAlign:
                        align[cellIndex] === "center"
                          ? "center"
                          : align[cellIndex] === "right"
                            ? "right"
                            : "left",
                    },
                  ]}
                >
                  <Inline nodes={cell.children} />
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const HEADING_SIZES = [24, 22, 20, 19, 18, 18] as const;

function Block(props: {
  readonly node: RootContent;
  readonly onOpenImage: (image: OpenImage) => void;
}): ReactNode {
  const { node, onOpenImage } = props;
  switch (node.type) {
    case "paragraph": {
      const [only] = node.children;
      if (node.children.length === 1 && only?.type === "image") {
        const url = safeLinkUrl(only.url);
        if (url !== null && url.startsWith("https:")) {
          return (
            <Pressable onPress={() => onOpenImage({ source: { uri: url } })}>
              <Image
                source={{ uri: url }}
                accessibilityLabel={only.alt ?? undefined}
                style={styles.image}
                contentFit="contain"
              />
            </Pressable>
          );
        }
      }
      return (
        <Text selectable style={styles.body}>
          <Inline nodes={node.children} />
        </Text>
      );
    }
    case "heading": {
      const size = HEADING_SIZES[node.depth - 1] ?? fontSize.body;
      return (
        <Text selectable style={[styles.heading, { fontSize: size, lineHeight: size * 1.3 }]}>
          <Inline nodes={node.children} />
        </Text>
      );
    }
    case "list":
      return (
        <View style={styles.list}>
          {node.children.map((item, index) => (
            <View key={nodeKey(item)} style={styles.listItem}>
              <Text style={styles.listMarker}>
                {item.checked === true
                  ? "☑"
                  : item.checked === false
                    ? "☐"
                    : node.ordered
                      ? `${(node.start ?? 1) + index}.`
                      : "•"}
              </Text>
              <View style={styles.listBody}>
                {item.children.map((child) => (
                  <Block key={nodeKey(child)} node={child} onOpenImage={onOpenImage} />
                ))}
              </View>
            </View>
          ))}
        </View>
      );
    case "blockquote":
      return (
        <View style={styles.quote}>
          {node.children.map((child) => (
            <Block key={nodeKey(child)} node={child} onOpenImage={onOpenImage} />
          ))}
        </View>
      );
    case "code":
      return <CodeBlock code={node.value} lang={node.lang} />;
    case "table":
      return <TableBlock table={node} />;
    case "thematicBreak":
      return <View style={styles.rule} />;
    case "html":
      return (
        <Text selectable style={styles.body}>
          {node.value}
        </Text>
      );
    case "footnoteDefinition":
      return (
        <View style={styles.footnote}>
          {node.children.map((child) => (
            <Block key={nodeKey(child)} node={child} onOpenImage={onOpenImage} />
          ))}
        </View>
      );
    default:
      return null;
  }
}

/**
 * A bot reply as rich text: headings, lists and task lists, quotes, tables that scroll sideways,
 * and code blocks with highlighting and a copy button. Links open only http(s), mail and phone.
 */
export const Markdown = memo(function Markdown(props: {
  readonly text: string;
  readonly onOpenImage: (image: OpenImage) => void;
}) {
  const tree = useMemo(() => parseMarkdown(props.text), [props.text]);
  return (
    <View style={styles.root}>
      {tree.children.map((node) => (
        <Block key={nodeKey(node)} node={node} onOpenImage={props.onOpenImage} />
      ))}
    </View>
  );
});

const styles = StyleSheet.create({
  root: { gap: 10 },
  body: { fontSize: fontSize.body, lineHeight: 27, color: colors.text },
  heading: { fontWeight: "700", color: colors.text, marginTop: 4 },
  strong: { fontWeight: "700" },
  emphasis: { fontStyle: "italic" },
  delete: { textDecorationLine: "line-through" },
  inlineCode: {
    fontFamily: MONO,
    fontSize: fontSize.body - 3,
    color: colors.codeText,
    backgroundColor: colors.codeBackground,
  },
  link: { color: colors.primary, textDecorationLine: "underline" },
  list: { gap: 6 },
  listItem: { flexDirection: "row", gap: 8 },
  listMarker: {
    minWidth: 18,
    fontSize: fontSize.body,
    lineHeight: 27,
    color: colors.primary,
    fontWeight: "700",
  },
  listBody: { flex: 1, gap: 6 },
  quote: {
    borderLeftWidth: 4,
    borderLeftColor: colors.primarySoft,
    paddingLeft: 12,
    gap: 8,
  },
  codeBlock: {
    borderRadius: 14,
    backgroundColor: colors.codeBackground,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: "hidden",
  },
  codeHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  codeLanguage: { fontSize: 13, color: colors.muted },
  codeCopy: { fontSize: 13, fontWeight: "700", color: colors.primary },
  code: {
    fontFamily: MONO,
    fontSize: 14,
    lineHeight: 21,
    color: colors.codeText,
    padding: 12,
  },
  tableScroll: { flexGrow: 0 },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden" },
  tableRow: { flexDirection: "row", borderTopWidth: 1, borderTopColor: colors.border },
  tableHeader: { backgroundColor: colors.primarySoft, borderTopWidth: 0 },
  tableCell: { width: 140, paddingHorizontal: 10, paddingVertical: 8 },
  tableCellDivider: { borderLeftWidth: 1, borderLeftColor: colors.border },
  tableText: { fontSize: fontSize.small, lineHeight: 21, color: colors.text },
  rule: { height: 1, backgroundColor: colors.border, marginVertical: 4 },
  image: { width: "100%", height: 220, borderRadius: 14 },
  footnote: { opacity: 0.8 },
});
