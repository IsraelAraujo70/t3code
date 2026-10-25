import type { GuestHtmlRender } from "@t3tools/contracts";
import { memo, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { htmlSource, type BotId } from "./api";
import {
  allowsPageLoad,
  BIA_HTML_THEME,
  BIA_HTML_THEME_FRAGMENT,
  externalLink,
  inlineFrameHeight,
  MAX_INLINE_PAGE_HEIGHT,
  readPageHeight,
  REPORT_HEIGHT_SCRIPT,
} from "./htmlPage";
import type { Pairing } from "./pairing";
import { colors, fontSize } from "./theme";

/**
 * One page in a WebView with T3's restrictions: the server sends it under a sandbox CSP (an opaque
 * origin, so no app storage, cookies or API with Bia's token), the page never navigates away, new
 * windows go to the browser only for http(s), and no file access.
 */
function PageView(props: {
  readonly source: { readonly uri: string; readonly headers: Record<string, string> };
  readonly title: string;
  readonly inline: boolean;
  readonly scrollable: boolean;
  readonly onHeight?: (height: number) => void;
  readonly onError: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [generation, setGeneration] = useState(0);
  const crashes = useRef(0);
  const source = useMemo(
    () => ({ uri: props.source.uri + BIA_HTML_THEME_FRAGMENT, headers: props.source.headers }),
    [props.source],
  );
  const restart = () => {
    crashes.current += 1;
    if (crashes.current > 1) {
      props.onError();
      return;
    }
    setLoaded(false);
    setGeneration((value) => value + 1);
  };
  return (
    <View style={styles.page}>
      <WebView
        key={generation}
        source={source}
        accessibilityLabel={props.title}
        style={styles.webView}
        originWhitelist={["http://*", "https://*"]}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        geolocationEnabled={false}
        setSupportMultipleWindows
        scrollEnabled={props.scrollable}
        nestedScrollEnabled={props.inline && props.scrollable}
        overScrollMode={props.inline ? "never" : "always"}
        showsVerticalScrollIndicator={!props.inline}
        onShouldStartLoadWithRequest={(request) => allowsPageLoad(request, props.source.uri)}
        onOpenWindow={(event) => {
          const url = externalLink(event.nativeEvent.targetUrl);
          if (url !== null) void Linking.openURL(url);
        }}
        injectedJavaScript={REPORT_HEIGHT_SCRIPT}
        onMessage={(event: WebViewMessageEvent): void => {
          const height = readPageHeight(event.nativeEvent.data);
          if (height !== null) props.onHeight?.(height);
        }}
        onLoadEnd={() => setLoaded(true)}
        onError={props.onError}
        onHttpError={props.onError}
        onRenderProcessGone={restart}
        onContentProcessDidTerminate={restart}
      />
      {loaded ? null : (
        <View pointerEvents="none" style={styles.loading}>
          <ActivityIndicator color={colors.primary} />
        </View>
      )}
    </View>
  );
}

/** A page the bot published, inline in the chat, with a button to open it full screen. */
export const HtmlFrame = memo(function HtmlFrame(props: {
  readonly pairing: Pairing;
  readonly botId: BotId;
  readonly page: GuestHtmlRender;
}) {
  const insets = useSafeAreaInsets();
  const source = useMemo(
    () => htmlSource(props.pairing, props.botId, props.page.id),
    [props.pairing, props.botId, props.page.id],
  );
  const [measured, setMeasured] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const height = inlineFrameHeight(props.page.height, measured);
  const overflows = measured !== null && measured > MAX_INLINE_PAGE_HEIGHT;

  return (
    <View style={[styles.frame, { height }]}>
      {failed ? (
        <Pressable
          accessibilityRole="button"
          style={styles.failed}
          onPress={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          <Text style={styles.failedText}>
            Não consegui abrir a página. Toque para tentar de novo.
          </Text>
        </Pressable>
      ) : (
        <PageView
          key={attempt}
          source={source}
          title={props.page.title}
          inline
          scrollable={overflows}
          onHeight={setMeasured}
          onError={() => setFailed(true)}
        />
      )}
      {failed ? null : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Abrir ${props.page.title} em tela cheia`}
          hitSlop={8}
          style={styles.expand}
          onPress={() => setExpanded(true)}
        >
          <Text style={styles.expandText}>⤢</Text>
        </Pressable>
      )}
      <Modal visible={expanded} animationType="slide" onRequestClose={() => setExpanded(false)}>
        <View style={[styles.fullScreen, { paddingTop: insets.top }]}>
          <View style={styles.fullHeader}>
            <Text style={styles.fullTitle} numberOfLines={1}>
              {props.page.title}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Fechar"
              hitSlop={12}
              onPress={() => setExpanded(false)}
            >
              <Text style={styles.fullClose}>✕</Text>
            </Pressable>
          </View>
          {expanded ? (
            <PageView
              source={source}
              title={props.page.title}
              inline={false}
              scrollable
              onError={() => setExpanded(false)}
            />
          ) : null}
        </View>
      </Modal>
    </View>
  );
});

const styles = StyleSheet.create({
  frame: { width: "100%", borderRadius: 14, overflow: "hidden" },
  page: { flex: 1 },
  webView: { flex: 1, backgroundColor: BIA_HTML_THEME.variables["--background"] },
  loading: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center" },
  failed: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    backgroundColor: colors.primarySoft,
  },
  failedText: { fontSize: fontSize.small, color: colors.text, textAlign: "center" },
  expand: {
    position: "absolute",
    top: 6,
    right: 6,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(255,255,255,0.9)",
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
    justifyContent: "center",
  },
  expandText: { fontSize: 18, color: colors.primary },
  fullScreen: { flex: 1, backgroundColor: colors.background },
  fullHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.card,
  },
  fullTitle: { flex: 1, fontSize: fontSize.large, fontWeight: "700", color: colors.text },
  fullClose: { fontSize: 24, color: colors.primary },
});
