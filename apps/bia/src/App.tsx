import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  AppState,
  BackHandler,
  Linking,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import { ERROR_MESSAGES, type BotId } from "./api";
import { useAppUpdateChecks } from "./appUpdateDevice";
import { BotListScreen } from "./BotListScreen";
import { ChatScreen } from "./ChatScreen";
import {
  listenForNotificationTaps,
  registerForPush,
  setUpNotifications,
  showReplyNotification,
  unregisterForPush,
} from "./notifications";
import { parsePairing, type Pairing } from "./pairing";
import { PairingScreen } from "./PairingScreen";
import { createSession, type FinishedReply, type Session } from "./session";
import { clearStorage, loadPairing } from "./storage";
import { colors, fontSize } from "./theme";
import { UpdateNotice } from "./UpdateNotice";

type Phase =
  | { readonly kind: "starting" }
  | {
      readonly kind: "pairing";
      readonly link: string | null;
      readonly notice: string | null;
      /** Set when a new link arrived while paired, so Bia can go back to it. */
      readonly previous: Pairing | null;
    }
  | { readonly kind: "paired"; readonly pairing: Pairing };

type Screen = { readonly name: "list" } | { readonly name: "chat"; readonly botId: BotId };

interface Banner {
  readonly botId: BotId;
  readonly title: string;
  readonly body: string;
}

const BANNER_MS = 6_000;

function samePairing(a: Pairing | null, b: Pairing | null): boolean {
  return a !== null && b !== null && a.server === b.server && a.token === b.token;
}

function replyPreview(reply: FinishedReply): string {
  const text = reply.message.text.replace(/\s+/g, " ").trim();
  if (text.length === 0) return "📷 Foto";
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

function ReplyBanner(props: { readonly banner: Banner; readonly onPress: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <Pressable
      style={[styles.banner, { top: insets.top + 8 }]}
      onPress={props.onPress}
      accessibilityRole="button"
    >
      <Text style={styles.bannerTitle} numberOfLines={1}>
        {props.banner.title}
      </Text>
      <Text style={styles.bannerBody} numberOfLines={2}>
        {props.banner.body}
      </Text>
    </Pressable>
  );
}

function SessionApp(props: {
  readonly session: Session;
  readonly banner: Banner | null;
  readonly onActiveBotChange: (botId: BotId | null) => void;
  readonly onDismissBanner: () => void;
  readonly onLogout: () => void;
}) {
  const { session, banner, onActiveBotChange, onDismissBanner } = props;
  const [screen, setScreen] = useState<Screen>({ name: "list" });

  const openChat = useCallback(
    (botId: BotId) => {
      onDismissBanner();
      setScreen({ name: "chat", botId });
    },
    [onDismissBanner],
  );
  const backToList = useCallback(() => setScreen({ name: "list" }), []);

  useEffect(() => {
    onActiveBotChange(screen.name === "chat" ? screen.botId : null);
  }, [onActiveBotChange, screen]);

  // A tapped notification only carries a string id; it opens once the bot list confirms it,
  // which on a cold start is after the first load.
  useEffect(() => {
    let stopWaiting = () => {};
    const stopListening = listenForNotificationTaps((botId) => {
      stopWaiting();
      const tryOpen = () => {
        const bot = session.getState().bots.find((candidate) => candidate.id === botId);
        if (bot !== undefined) openChat(bot.id);
        return bot !== undefined;
      };
      if (tryOpen()) return;
      const unsubscribe = session.subscribe(() => {
        if (tryOpen()) unsubscribe();
      });
      stopWaiting = unsubscribe;
    });
    return () => {
      stopWaiting();
      stopListening();
    };
  }, [session, openChat]);

  useEffect(() => {
    if (screen.name !== "chat") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      backToList();
      return true;
    });
    return () => subscription.remove();
  }, [screen, backToList]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") session.resume();
    });
    return () => subscription.remove();
  }, [session]);

  return (
    <View style={styles.fill}>
      {screen.name === "chat" ? (
        <ChatScreen key={screen.botId} session={session} botId={screen.botId} onBack={backToList} />
      ) : (
        <BotListScreen session={session} onOpen={openChat} onLogout={props.onLogout} />
      )}
      {screen.name === "list" ? <UpdateNotice /> : null}
      {banner !== null ? (
        <ReplyBanner banner={banner} onPress={() => openChat(banner.botId)} />
      ) : null}
    </View>
  );
}

function PairedApp(props: {
  readonly pairing: Pairing;
  readonly onUnauthorized: () => void;
  readonly onLoggedOut: () => void;
}) {
  const { pairing, onUnauthorized, onLoggedOut } = props;
  const [session, setSession] = useState<Session | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const activeBot = useRef<BotId | null>(null);
  // With push registered, the server's FCM message already notifies a backgrounded app.
  const pushRegistered = useRef(false);
  useAppUpdateChecks(pairing);

  useEffect(() => {
    const created = createSession({
      pairing,
      onUnauthorized,
      onReplyFinished: (reply) => {
        const body = replyPreview(reply);
        if (AppState.currentState !== "active") {
          if (pushRegistered.current) return;
          showReplyNotification({ botId: reply.bot.id, title: reply.bot.name, body }).catch(
            (error: unknown) => console.warn("Notificação local falhou:", error),
          );
          return;
        }
        if (activeBot.current === reply.bot.id) return;
        setBanner({ botId: reply.bot.id, title: `${reply.bot.name} respondeu`, body });
      },
    });
    setSession(created);
    return () => created.dispose();
  }, [pairing, onUnauthorized]);

  useEffect(() => {
    setUpNotifications()
      .then(() => registerForPush(pairing))
      .then((registered) => {
        pushRegistered.current = registered;
      })
      .catch((error: unknown) => console.warn("Registro de push falhou:", error));
  }, [pairing]);

  useEffect(() => {
    if (banner === null) return;
    const timer = setTimeout(() => setBanner(null), BANNER_MS);
    return () => clearTimeout(timer);
  }, [banner]);

  const dismissBanner = useCallback(() => setBanner(null), []);
  const setActiveBot = useCallback((botId: BotId | null) => {
    activeBot.current = botId;
  }, []);

  const logout = useCallback(() => {
    Alert.alert("Sair", "Quer mesmo sair? Para entrar de novo você vai precisar de um QR code.", [
      { text: "Cancelar", style: "cancel" },
      {
        text: "Sair",
        style: "destructive",
        onPress: () => {
          void unregisterForPush(pairing).then(clearStorage).finally(onLoggedOut);
        },
      },
    ]);
  }, [pairing, onLoggedOut]);

  if (session === null) return <Loading />;
  return (
    <SessionApp
      session={session}
      banner={banner}
      onActiveBotChange={setActiveBot}
      onDismissBanner={dismissBanner}
      onLogout={logout}
    />
  );
}

function Loading() {
  return (
    <View style={[styles.fill, styles.center]}>
      <ActivityIndicator size="large" color={colors.primary} />
    </View>
  );
}

function Root() {
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });

  useEffect(() => {
    let cancelled = false;
    const start = async () => {
      const [stored, initialUrl] = await Promise.all([
        loadPairing().catch(() => null),
        Linking.getInitialURL().catch(() => null),
      ]);
      if (cancelled) return;
      const url = initialUrl ?? null;
      const linked = url === null ? null : parsePairing(url);
      if (url !== null && linked !== null && !samePairing(linked, stored)) {
        setPhase({ kind: "pairing", link: url, notice: null, previous: stored });
      } else if (stored !== null) {
        setPhase({ kind: "paired", pairing: stored });
      } else {
        setPhase({ kind: "pairing", link: null, notice: null, previous: null });
      }
    };
    void start();
    const subscription = Linking.addEventListener("url", (event) => {
      const url = event.url;
      if (url === undefined || parsePairing(url) === null) return;
      setPhase((current) => ({
        kind: "pairing",
        link: url,
        notice: null,
        previous:
          current.kind === "paired"
            ? current.pairing
            : current.kind === "pairing"
              ? current.previous
              : null,
      }));
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, []);

  const onPaired = useCallback((pairing: Pairing) => setPhase({ kind: "paired", pairing }), []);
  const onLoggedOut = useCallback(
    () => setPhase({ kind: "pairing", link: null, notice: null, previous: null }),
    [],
  );
  // Several streams can hit the same 401 at once; only the first one moves the app.
  const onUnauthorized = useCallback(() => {
    clearStorage().catch(() => undefined);
    setPhase((current) =>
      current.kind === "paired"
        ? { kind: "pairing", link: null, notice: ERROR_MESSAGES.unauthorized, previous: null }
        : current,
    );
  }, []);

  switch (phase.kind) {
    case "starting":
      return <Loading />;
    case "pairing": {
      const { previous } = phase;
      return (
        <PairingScreen
          key={`${phase.link ?? ""}|${phase.notice ?? ""}`}
          link={phase.link}
          notice={phase.notice}
          onPaired={onPaired}
          onCancel={previous === null ? null : () => onPaired(previous)}
        />
      );
    }
    case "paired":
      return (
        <PairedApp
          pairing={phase.pairing}
          onUnauthorized={onUnauthorized}
          onLoggedOut={onLoggedOut}
        />
      );
    default: {
      const _exhaustive: never = phase;
      return _exhaustive;
    }
  }
}

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <Root />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: colors.background },
  center: { alignItems: "center", justifyContent: "center" },
  banner: {
    position: "absolute",
    left: 12,
    right: 12,
    padding: 14,
    borderRadius: 18,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    elevation: 6,
    shadowColor: colors.text,
    shadowOpacity: 0.15,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  bannerTitle: { fontSize: fontSize.body, fontWeight: "700", color: colors.primary },
  bannerBody: { fontSize: fontSize.small, lineHeight: 21, color: colors.text, marginTop: 2 },
});
