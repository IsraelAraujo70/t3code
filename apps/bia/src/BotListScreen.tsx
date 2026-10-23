import type { GuestBotSummary } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { BotId } from "./api";
import { lastMessagePreview } from "./conversation";
import { useSessionState, type Session } from "./session";
import { colors, fontSize } from "./theme";

function BotCard(props: {
  readonly session: Session;
  readonly bot: GuestBotSummary;
  readonly onOpen: (botId: BotId) => void;
}) {
  const conversation = useSessionState(props.session, (state) => state.conversations[props.bot.id]);
  const preview = conversation === undefined ? null : lastMessagePreview(conversation);
  const subtitle = conversation?.working
    ? "digitando…"
    : preview === null
      ? "Toque para conversar"
      : `${preview.fromBia ? "Você: " : ""}${preview.text}`;

  return (
    <Pressable
      style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
      onPress={() => props.onOpen(props.bot.id)}
    >
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>
          {props.bot.name.trim().charAt(0).toUpperCase() || "?"}
        </Text>
      </View>
      <View style={styles.cardText}>
        <Text style={styles.name} numberOfLines={1}>
          {props.bot.name}
        </Text>
        <Text
          style={[styles.preview, conversation?.working && styles.previewWorking]}
          numberOfLines={2}
        >
          {subtitle}
        </Text>
      </View>
    </Pressable>
  );
}

export function BotListScreen(props: {
  readonly session: Session;
  readonly onOpen: (botId: BotId) => void;
  readonly onLogout: () => void;
}) {
  const insets = useSafeAreaInsets();
  const bots = useSessionState(props.session, (state) => state.bots);
  const botsLoaded = useSessionState(props.session, (state) => state.botsLoaded);
  const guestName = useSessionState(props.session, (state) => state.guestName);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      props.session.refresh().then(
        () => setError(null),
        (cause: unknown) =>
          setError(cause instanceof Error ? cause.message : "Não consegui atualizar."),
      ),
    [props.session],
  );

  // Quietly on every visit, so previews are fresh when Bia comes back from a chat.
  useEffect(() => {
    void load();
  }, [load]);

  const refresh = useCallback(() => {
    setRefreshing(true);
    void load().finally(() => setRefreshing(false));
  }, [load]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerText}>
          <Text style={styles.greeting}>Oi, {guestName || "Bia"}! 💛</Text>
          <Text style={styles.title}>Meus assistentes</Text>
        </View>
        <Pressable hitSlop={12} onPress={props.onLogout}>
          <Text style={styles.logout}>Sair</Text>
        </Pressable>
      </View>
      {error !== null ? <Text style={styles.error}>{error}</Text> : null}
      <FlatList
        data={bots}
        keyExtractor={(bot) => bot.id}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 16 }]}
        renderItem={({ item }) => (
          <BotCard session={props.session} bot={item} onOpen={props.onOpen} />
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} colors={[colors.primary]} />
        }
        ListEmptyComponent={
          <Text style={styles.empty}>
            {botsLoaded ? "Nenhum assistente por aqui ainda." : "Carregando seus assistentes…"}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 12,
  },
  headerText: { flex: 1 },
  greeting: { fontSize: fontSize.body, color: colors.muted },
  title: { fontSize: fontSize.title, fontWeight: "800", color: colors.text },
  logout: { fontSize: fontSize.body, color: colors.primary, paddingTop: 4 },
  list: { paddingHorizontal: 16, gap: 12 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    padding: 16,
    borderRadius: 20,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardPressed: { backgroundColor: colors.primarySoft },
  avatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: colors.primarySoft,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 24, fontWeight: "700", color: colors.primary },
  cardText: { flex: 1, gap: 2 },
  name: { fontSize: fontSize.large, fontWeight: "700", color: colors.text },
  preview: { fontSize: fontSize.small, lineHeight: 21, color: colors.muted },
  previewWorking: { color: colors.primary },
  empty: { textAlign: "center", marginTop: 48, fontSize: fontSize.body, color: colors.muted },
  error: {
    marginHorizontal: 16,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    fontSize: fontSize.small,
    color: colors.danger,
    backgroundColor: colors.primarySoft,
  },
});
