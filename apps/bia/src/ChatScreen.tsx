import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Pressable,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { BotId } from "./api";
import { BotFace } from "./BotFace";
import { Composer, type Draft } from "./Composer";
import { EMPTY_CONVERSATION } from "./conversation";
import { ImageViewer } from "./ImageViewer";
import { MessageBubble, type ChatItem, type OpenImage } from "./MessageBubble";
import { useSessionState, type Session } from "./session";
import { colors, fontSize } from "./theme";
import { stopVoiceFor } from "./voice/controller";
import { ListenButton } from "./voice/ListenButton";
import { VoiceControls } from "./voice/VoiceControls";
import { VoiceOrb } from "./voice/VoiceOrb";

/** How close to the end still counts as "reading the latest", in points. */
const STICK_TO_BOTTOM_PX = 80;

function useKeyboardVisible(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setVisible(false));
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return visible;
}

export function ChatScreen(props: {
  readonly session: Session;
  readonly botId: BotId;
  readonly onBack: () => void;
}) {
  const { session, botId, onBack } = props;
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardVisible();
  const bot = useSessionState(session, (state) => state.bots.find((item) => item.id === botId));
  const botsLoaded = useSessionState(session, (state) => state.botsLoaded);
  const ownerName = useSessionState(session, (state) => state.ownerName);
  const conversation =
    useSessionState(session, (state) => state.conversations[botId]) ?? EMPTY_CONVERSATION;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openImage, setOpenImage] = useState<OpenImage | null>(null);
  const listRef = useRef<FlatList<ChatItem>>(null);
  const atBottom = useRef(true);
  const scrolledOnce = useRef(false);

  useEffect(() => {
    session.loadHistory(botId).then(
      () => setLoadError(null),
      (error: unknown) =>
        setLoadError(error instanceof Error ? error.message : "Não consegui carregar a conversa."),
    );
  }, [session, botId]);

  // The voice talks to the open chat; leaving it hangs up.
  useEffect(() => () => stopVoiceFor(botId), [botId]);

  // A notification can point at a bot that is no longer hers.
  useEffect(() => {
    if (botsLoaded && bot === undefined) onBack();
  }, [botsLoaded, bot, onBack]);

  const items = useMemo<ChatItem[]>(
    () => [
      ...conversation.messages.map((message): ChatItem => ({
        kind: "server",
        key: message.id,
        message,
      })),
      ...conversation.outbox.map((message): ChatItem => ({
        kind: "outgoing",
        key: message.localId,
        message,
      })),
    ],
    [conversation.messages, conversation.outbox],
  );

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    atBottom.current =
      contentSize.height - (contentOffset.y + layoutMeasurement.height) < STICK_TO_BOTTOM_PX;
  }, []);

  const onContentSizeChange = useCallback(() => {
    if (!atBottom.current) return;
    listRef.current?.scrollToEnd({ animated: scrolledOnce.current });
    scrolledOnce.current = true;
  }, []);

  const onSend = useCallback(
    async (draft: Draft) => {
      atBottom.current = true;
      await session.send({
        botId,
        text: draft.text,
        uploads: draft.images.map((image) => image.upload),
        imageUris: draft.images.map((image) => image.uri),
      });
    },
    [session, botId],
  );

  const renderItem = useCallback(
    ({ item }: { item: ChatItem }) => (
      <>
        <MessageBubble
          item={item}
          pairing={session.pairing}
          botId={botId}
          ownerName={ownerName}
          onOpenImage={setOpenImage}
        />
        <ListenButton item={item} pairing={session.pairing} botId={botId} />
      </>
    ),
    [session.pairing, botId, ownerName],
  );

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <Pressable accessibilityLabel="Voltar" hitSlop={12} onPress={onBack} style={styles.back}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerFace}>
          <BotFace botId={botId} size={34} />
        </View>
        <View style={styles.headerText}>
          <Text style={styles.title} numberOfLines={1}>
            {bot?.name ?? ""}
          </Text>
          {conversation.working ? <Text style={styles.subtitle}>digitando…</Text> : null}
        </View>
      </View>

      <VoiceOrb botId={botId}>
        <FlatList
          ref={listRef}
          style={styles.list}
          contentContainerStyle={styles.listContent}
          data={items}
          keyExtractor={(item) => item.key}
          renderItem={renderItem}
          onScroll={onScroll}
          scrollEventThrottle={100}
          onContentSizeChange={onContentSizeChange}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            conversation.loaded ? (
              <Text style={styles.empty}>Mande um oi para começar a conversa 😊</Text>
            ) : undefined
          }
          ListFooterComponent={
            conversation.working ? <Text style={styles.typing}>● ● ● digitando…</Text> : undefined
          }
        />
      </VoiceOrb>

      {loadError !== null ? <Text style={styles.error}>{loadError}</Text> : null}

      <Composer
        bottomInset={keyboardVisible ? 0 : insets.bottom}
        onSend={onSend}
        voice={<VoiceControls pairing={session.pairing} botId={botId} />}
      />

      <ImageViewer image={openImage} onClose={() => setOpenImage(null)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    paddingBottom: 10,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  back: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backText: { fontSize: 40, lineHeight: 44, color: colors.primary },
  headerFace: {
    width: 42,
    height: 42,
    borderRadius: 21,
    marginRight: 10,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  headerText: { flex: 1 },
  title: { fontSize: fontSize.large, fontWeight: "700", color: colors.text },
  subtitle: { fontSize: fontSize.small, color: colors.primary },
  list: { flex: 1 },
  listContent: { paddingVertical: 12 },
  empty: { textAlign: "center", marginTop: 48, fontSize: fontSize.body, color: colors.muted },
  typing: { marginLeft: 20, marginTop: 6, fontSize: fontSize.small, color: colors.muted },
  error: {
    textAlign: "center",
    padding: 8,
    fontSize: fontSize.small,
    color: colors.danger,
    backgroundColor: colors.primarySoft,
  },
});
