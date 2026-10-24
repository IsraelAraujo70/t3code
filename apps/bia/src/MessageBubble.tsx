import type { GuestMessage } from "@t3tools/contracts";
import { Image } from "expo-image";
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { attachmentSource, type BotId } from "./api";
import { BotFace } from "./BotFace";
import { authorOf, OWNER_FALLBACK, type OutgoingMessage } from "./conversation";
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
  /** The owner's name, shown on their messages in a bot they share with Bia. */
  readonly ownerName: string | null;
  readonly onOpenImage: (source: ImageSource) => void;
}

/** The list rebuilds its items on every streamed chunk; only a changed message re-renders. */
function sameBubble(before: MessageBubbleProps, after: MessageBubbleProps): boolean {
  return (
    before.item.message === after.item.message &&
    before.pairing === after.pairing &&
    before.botId === after.botId &&
    before.ownerName === after.ownerName &&
    before.onOpenImage === after.onOpenImage
  );
}

export const MessageBubble = memo(function MessageBubble(props: MessageBubbleProps) {
  const { item } = props;
  const author = item.kind === "outgoing" ? "bia" : authorOf(item.message);
  const fromBia = author === "bia";
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
      {author === "bot" ? (
        <View style={styles.face}>
          <BotFace botId={props.botId} size={26} />
        </View>
      ) : null}
      <View
        style={[
          styles.bubble,
          fromBia ? styles.userBubble : author === "owner" ? styles.ownerBubble : styles.botBubble,
          item.kind === "outgoing" && styles.pending,
        ]}
      >
        {author === "owner" ? (
          <Text style={styles.ownerName}>{props.ownerName ?? OWNER_FALLBACK}</Text>
        ) : null}
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
  rowLeft: { justifyContent: "flex-start", alignItems: "flex-end", gap: 6 },
  face: { marginBottom: 2 },
  rowRight: { justifyContent: "flex-end" },
  bubble: { maxWidth: "80%", borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  botBubble: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: 6,
  },
  ownerBubble: {
    backgroundColor: colors.primarySoft,
    borderBottomLeftRadius: 6,
  },
  ownerName: { fontSize: 13, fontWeight: "700", color: colors.primary, marginBottom: -4 },
  userBubble: { backgroundColor: colors.userBubble, borderBottomRightRadius: 6 },
  pending: { opacity: 0.7 },
  text: { fontSize: fontSize.body, lineHeight: 26, color: colors.text },
  userText: { color: colors.userText },
  cursor: { color: colors.primary },
  status: { fontSize: 13, color: colors.userText, alignSelf: "flex-end" },
  photos: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  photo: { width: 180, height: 180, borderRadius: 14, backgroundColor: colors.primarySoft },
});
