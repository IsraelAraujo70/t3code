import type { GuestMessage } from "@t3tools/contracts";
import { Image } from "expo-image";
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { attachmentSource, type BotId } from "./api";
import { BotFace } from "./BotFace";
import { authorOf, OWNER_FALLBACK, type OutgoingMessage } from "./conversation";
import { HtmlFrame } from "./HtmlFrame";
import { Markdown } from "./Markdown";
import type { Pairing } from "./pairing";
import { colors, fontSize } from "./theme";

export type ImageSource = { readonly uri: string; readonly headers?: Record<string, string> };

/** What the full-screen viewer opens: the image and, when known, its type for sharing. */
export interface OpenImage {
  readonly source: ImageSource;
  readonly mimeType?: string;
}

export type ChatItem =
  | { readonly kind: "server"; readonly key: string; readonly message: GuestMessage }
  | { readonly kind: "outgoing"; readonly key: string; readonly message: OutgoingMessage };

function Photos(props: {
  readonly images: readonly OpenImage[];
  readonly onOpen: (image: OpenImage) => void;
}) {
  if (props.images.length === 0) return null;
  return (
    <View style={styles.photos}>
      {props.images.map((image) => (
        <Pressable key={image.source.uri} onPress={() => props.onOpen(image)}>
          <Image source={image.source} style={styles.photo} contentFit="cover" transition={0} />
        </Pressable>
      ))}
    </View>
  );
}

/** An image the bot made: as wide as the chat allows, at its own proportions. */
function MadeImage(props: {
  readonly image: OpenImage;
  readonly onOpen: (image: OpenImage) => void;
}) {
  const [aspectRatio, setAspectRatio] = useState(1);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel="Imagem criada. Toque para ampliar."
      onPress={() => props.onOpen(props.image)}
    >
      <Image
        source={props.image.source}
        style={[styles.madeImage, { aspectRatio }]}
        contentFit="cover"
        transition={150}
        onLoad={(event) => {
          const { width, height } = event.source;
          if (width > 0 && height > 0) setAspectRatio(width / height);
        }}
      />
    </Pressable>
  );
}

interface MessageBubbleProps {
  readonly item: ChatItem;
  readonly pairing: Pairing;
  readonly botId: BotId;
  /** The owner's name, shown on their messages in a bot they share with Bia. */
  readonly ownerName: string | null;
  readonly onOpenImage: (image: OpenImage) => void;
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

/** The bot's side, as in ChatGPT: no bubble, the whole width for text, tables, code and pages. */
function BotMessage(props: MessageBubbleProps & { readonly message: GuestMessage }) {
  const { message } = props;
  const images = message.attachments.map((attachment) => ({
    source: attachmentSource(props.pairing, props.botId, attachment.id),
    mimeType: attachment.mimeType,
  }));
  return (
    <View style={styles.botRow}>
      <View style={styles.face}>
        <BotFace botId={props.botId} size={26} />
      </View>
      <View style={styles.botContent}>
        {images.map((image) => (
          <MadeImage key={image.source.uri} image={image} onOpen={props.onOpenImage} />
        ))}
        {message.html === undefined ? null : (
          <HtmlFrame pairing={props.pairing} botId={props.botId} page={message.html} />
        )}
        {message.text.length > 0 ? (
          <Markdown text={message.text} onOpenImage={props.onOpenImage} />
        ) : null}
        {message.streaming ? <Text style={styles.cursor}>▍</Text> : null}
      </View>
    </View>
  );
}

export const MessageBubble = memo(function MessageBubble(props: MessageBubbleProps) {
  const { item } = props;
  const author = item.kind === "outgoing" ? "bia" : authorOf(item.message);
  if (item.kind === "server" && author === "bot") {
    return <BotMessage {...props} message={item.message} />;
  }
  const fromBia = author === "bia";
  const images: readonly OpenImage[] =
    item.kind === "outgoing"
      ? item.message.imageUris.map((uri) => ({ source: { uri } }))
      : item.message.attachments.map((attachment) => ({
          source: attachmentSource(props.pairing, props.botId, attachment.id),
          mimeType: attachment.mimeType,
        }));
  const text = item.message.text;

  return (
    <View style={[styles.row, fromBia ? styles.rowRight : styles.rowLeft]}>
      <View
        style={[
          styles.bubble,
          fromBia ? styles.userBubble : styles.ownerBubble,
          item.kind === "outgoing" && styles.pending,
        ]}
      >
        {author === "owner" ? (
          <Text style={styles.ownerName}>{props.ownerName ?? OWNER_FALLBACK}</Text>
        ) : null}
        <Photos images={images} onOpen={props.onOpenImage} />
        {text.length > 0 ? (
          <Text selectable style={[styles.text, fromBia && styles.userText]}>
            {text}
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
  botRow: { flexDirection: "row", gap: 8, paddingLeft: 10, paddingRight: 14, paddingVertical: 6 },
  face: { paddingTop: 2 },
  botContent: { flex: 1, minWidth: 0, gap: 10 },
  bubble: { maxWidth: "80%", borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, gap: 8 },
  ownerBubble: {
    backgroundColor: colors.primarySoft,
    borderBottomLeftRadius: 6,
  },
  ownerName: { fontSize: 13, fontWeight: "700", color: colors.primary, marginBottom: -4 },
  userBubble: { backgroundColor: colors.userBubble, borderBottomRightRadius: 6 },
  pending: { opacity: 0.7 },
  text: { fontSize: fontSize.body, lineHeight: 26, color: colors.text },
  userText: { color: colors.userText },
  cursor: { color: colors.primary, fontSize: fontSize.body },
  status: { fontSize: 13, color: colors.userText, alignSelf: "flex-end" },
  photos: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  photo: { width: 180, height: 180, borderRadius: 14, backgroundColor: colors.primarySoft },
  madeImage: {
    width: "100%",
    maxWidth: 420,
    borderRadius: 16,
    backgroundColor: colors.primarySoft,
  },
});
