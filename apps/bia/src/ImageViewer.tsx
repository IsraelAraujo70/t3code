import { File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import * as Sharing from "expo-sharing";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { ImageSource, OpenImage } from "./MessageBubble";
import { colors, fontSize } from "./theme";

const MAX_SCALE = 5;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 280;

const touchDistance = (event: GestureResponderEvent) => {
  const [a, b] = event.nativeEvent.touches;
  return a === undefined || b === undefined
    ? null
    : Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
};

/**
 * Pinch to zoom, drag while zoomed, double tap to zoom in or back out. Built on the responder
 * system, so it needs no gesture library.
 */
function ZoomableImage(props: { readonly source: ImageSource }) {
  // Created once and mutated by the responder only: none of it drives a render.
  const [scale] = useState(() => new Animated.Value(1));
  const [x] = useState(() => new Animated.Value(0));
  const [y] = useState(() => new Animated.Value(0));
  const [gesture] = useState(() => ({
    scale: 1,
    x: 0,
    y: 0,
    pinchFrom: null as number | null,
    pinchScale: 1,
    current: { scale: 1, x: 0, y: 0 },
    lastTap: 0,
    moved: false,
  }));

  const animateTo = (next: { scale: number; x: number; y: number }) => {
    gesture.scale = next.scale;
    gesture.x = next.x;
    gesture.y = next.y;
    gesture.current = next;
    Animated.parallel([
      Animated.spring(scale, { toValue: next.scale, useNativeDriver: true }),
      Animated.spring(x, { toValue: next.x, useNativeDriver: true }),
      Animated.spring(y, { toValue: next.y, useNativeDriver: true }),
    ]).start();
  };

  const [responder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        gesture.moved = false;
        gesture.pinchFrom = null;
      },
      onPanResponderMove: (event, state) => {
        const distance = touchDistance(event);
        if (distance !== null) {
          gesture.moved = true;
          if (gesture.pinchFrom === null) {
            gesture.pinchFrom = distance;
            gesture.pinchScale = gesture.current.scale;
          }
          const next = Math.min(
            MAX_SCALE,
            Math.max(1, gesture.pinchScale * (distance / gesture.pinchFrom)),
          );
          gesture.current = { ...gesture.current, scale: next };
          scale.setValue(next);
          return;
        }
        if (Math.abs(state.dx) + Math.abs(state.dy) > 6) gesture.moved = true;
        if (gesture.current.scale > 1) {
          gesture.current = {
            ...gesture.current,
            x: gesture.x + state.dx / gesture.current.scale,
            y: gesture.y + state.dy / gesture.current.scale,
          };
          x.setValue(gesture.current.x);
          y.setValue(gesture.current.y);
        }
      },
      onPanResponderRelease: () => {
        if (!gesture.moved) {
          const now = Date.now();
          if (now - gesture.lastTap < DOUBLE_TAP_MS) {
            gesture.lastTap = 0;
            animateTo(
              gesture.scale > 1
                ? { scale: 1, x: 0, y: 0 }
                : { scale: DOUBLE_TAP_SCALE, x: 0, y: 0 },
            );
            return;
          }
          gesture.lastTap = now;
        }
        animateTo(gesture.current.scale <= 1.02 ? { scale: 1, x: 0, y: 0 } : gesture.current);
      },
    }),
  );

  return (
    <View style={styles.stage} {...responder.panHandlers}>
      <Animated.View
        style={[styles.fill, { transform: [{ scale }, { translateX: x }, { translateY: y }] }]}
      >
        <Image source={props.source} style={styles.fill} contentFit="contain" />
      </Animated.View>
    </View>
  );
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/** Hands the image to Android's share sheet (save to the gallery or files, WhatsApp…). */
async function shareImage(source: ImageSource, mimeType: string | undefined) {
  if (!(await Sharing.isAvailableAsync())) {
    Alert.alert("Não dá para compartilhar", "Este celular não oferece compartilhamento.");
    return;
  }
  let uri = source.uri;
  if (!/^(?:file|content):/.test(uri)) {
    const name = `bia-${Math.abs(hash(uri))}.${EXTENSIONS[mimeType ?? ""] ?? "png"}`;
    const file = await File.downloadFileAsync(uri, new File(Paths.cache, name), {
      ...(source.headers === undefined ? {} : { headers: source.headers }),
      idempotent: true,
    });
    uri = file.uri;
  }
  await Sharing.shareAsync(uri, {
    ...(mimeType === undefined ? {} : { mimeType }),
    dialogTitle: "Salvar ou compartilhar",
  });
}

function hash(text: string) {
  let value = 0;
  for (let index = 0; index < text.length; index++) {
    value = (value * 31 + text.charCodeAt(index)) | 0;
  }
  return value;
}

/** A photo or generated image full screen: zoom it, then save or share it. */
export function ImageViewer(props: {
  readonly image: OpenImage | null;
  readonly onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [sharing, setSharing] = useState(false);
  const image = props.image;
  return (
    <Modal
      visible={image !== null}
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={props.onClose}
    >
      <View style={styles.backdrop}>
        {image !== null ? <ZoomableImage key={image.source.uri} source={image.source} /> : null}
        <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Fechar"
            hitSlop={12}
            onPress={props.onClose}
            style={styles.close}
          >
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>
        {image !== null ? (
          <View style={[styles.bottomBar, { paddingBottom: insets.bottom + 16 }]}>
            <Pressable
              accessibilityRole="button"
              disabled={sharing}
              style={styles.share}
              onPress={() => {
                setSharing(true);
                shareImage(image.source, image.mimeType)
                  .catch(() =>
                    Alert.alert("Não consegui", "Não deu para preparar a imagem. Tente de novo."),
                  )
                  .finally(() => setSharing(false));
              }}
            >
              {sharing ? (
                <ActivityIndicator color={colors.userText} />
              ) : (
                <Text style={styles.shareText}>Salvar ou compartilhar</Text>
              )}
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: colors.overlay },
  stage: { flex: 1, overflow: "hidden" },
  fill: { flex: 1, width: "100%", height: "100%" },
  topBar: { position: "absolute", top: 0, right: 0, paddingHorizontal: 12 },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeText: { fontSize: 22, color: "#FFFFFF" },
  bottomBar: { position: "absolute", left: 0, right: 0, bottom: 0, alignItems: "center" },
  share: {
    minWidth: 220,
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: "center",
  },
  shareText: { fontSize: fontSize.body, fontWeight: "700", color: colors.userText },
});
