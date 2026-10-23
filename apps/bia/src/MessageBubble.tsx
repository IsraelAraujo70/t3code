import type { GuestMessage } from "@t3tools/contracts";
import { Image } from "expo-image";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { attachmentSource, type BotId } from "./api";
import type { OutgoingMessage } from "./conversation";
import type { Pairing } from "./pairing";
import { colors, fontSize } from "./theme";

export type ImageSource = { readonly uri: string; readonly headers?: Record<string, string> };

export type ChatItem =
  | { readonly kind: "server"; readonly key: string; readonly message: GuestMessage }
  | { readonly kind: "outgoing"; readonly key: string; readonly message: OutgoingMessage };

function Photos(props: {
  readonly sources: readonly ImageSource[];
  readonly onOpen: (source: ImageSource) => void;
}) {
  if (props.sources.length === 0) return null;
  return (
    <View style={styles.photos}>
      {props.sources.map((source) => (
        <Pressable key={source.uri} onPress={() => props.onOpen(source)}>
          <Image source={source} style={styles.photo} contentFit="cover" transition={0} />
        </Pressable>
      ))}
    </View>
  );
}

interface MessageBubbleProps {
  readonly item: ChatItem;
  readonly pairing: Pairing;
  readonly botId: BotId;
  readonly onOpenImage: (source: ImageSource) => void;
}

/** The list rebuilds its items on every streamed chunk; only a changed message re-renders. */
function sameBubble(before: MessageBubbleProps, after: MessageBubbleProps): boolean {
  return (
    before.item.message === after.item.message &&
    before.pairing === after.pairing &&
    before.botId === after.botId &&
    before.onOpenImage === after.onOpenImage
  );
}

export const MessageBubble = memo(function MessageBubble(props: MessageBubbleProps) {
  const { item } = props;
  const fromBia = item.kind === "outgoing" || item.message.role === "user";
  const sources: readonly ImageSource[] =
    item.kind === "outgoing"
      ? item.message.imageUris.map((uri) => ({ uri }))
      : item.message.attachments.map((attachment) =>
          attachmentSource(props.pairing, props.botId, attachment.id),
        );
  const streaming = item.kind === "server" && item.message.streaming;
  const text = item.message.text;

  return (
    <View style={[styles.row, fromBia ? styles.rowRight : styles.rowLeft]}>
      <View
        style={[
          styles.bubble,
          fromBia ? styles.userBubble : styles.botBubble,
          item.kind === "outgoing" && styles.pending,
        ]}
      >
        <Photos sources={sources} onOpen={props.onOpenImage} />
        {text.length > 0 || streaming ? (
          <Text selectable style={[styles.text, fromBia && styles.userText]}>
            {text}
            {streaming ? <Text style={styles.cursor}> ▍</Text> : null}
          </Text>
        ) : null}
        {item.kind === "outgoing" ? <Text style={styles.status}>enviando…</Text> : null}
      </View>
    </View>
  );
}, sameBubble);

const styles = StyleSheet.create({
  row: { paddingHorizontal: 12, paddingVertical: 4, flexDirection: "row" },
  rowLeft: { justifyContent: "flex-start" },
  rowRight: { justifyContent: "flex-end" },
  bubble: { maxWidth: "85%", borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  botBubble: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 6,
  },
  userBubble: { backgroundColor: colors.userBubble, borderBottomRightRadius: 6 },
  pending: { opacity: 0.7 },
  text: { fontSize: fontSize.body, lineHeight: 26, color: colors.text },
  userText: { color: colors.userText },
  cursor: { color: colors.primary },
  status: { fontSize: 13, color: colors.userText, alignSelf: "flex-end" },
  photos: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  photo: { width: 180, height: 180, borderRadius: 14, backgroundColor: colors.primarySoft },
});
