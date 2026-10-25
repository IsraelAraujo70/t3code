import { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { noticeContent } from "./appUpdate";
import { appUpdate, useAppUpdate } from "./appUpdateDevice";
import { colors, fontSize } from "./theme";

/** A card at the bottom of the bot list while a new version of the app is available. */
export function UpdateNotice() {
  const insets = useSafeAreaInsets();
  const snapshot = useAppUpdate();
  const [tried, setTried] = useState(false);
  const content = noticeContent(snapshot, tried);
  if (content.kind === "hidden") return null;
  return (
    <View style={[styles.card, { bottom: insets.bottom + 12 }]}>
      {content.kind === "busy" ? (
        <View style={styles.busy}>
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.busyText}>{content.text}</Text>
        </View>
      ) : (
        <>
          <Text style={styles.title}>{content.title}</Text>
          <Text style={styles.body}>{content.body}</Text>
          <View style={styles.actions}>
            <Pressable hitSlop={8} onPress={appUpdate.dismiss} accessibilityRole="button">
              <Text style={styles.later}>Agora não</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
              onPress={() => {
                setTried(true);
                void appUpdate.install();
              }}
              accessibilityRole="button"
            >
              <Text style={styles.buttonText}>{content.action}</Text>
            </Pressable>
          </View>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    position: "absolute",
    left: 12,
    right: 12,
    padding: 16,
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
  busy: { flexDirection: "row", alignItems: "center", gap: 12 },
  busyText: { fontSize: fontSize.small, color: colors.text },
  title: { fontSize: fontSize.body, fontWeight: "700", color: colors.primary },
  body: { fontSize: fontSize.small, lineHeight: 21, color: colors.text, marginTop: 2 },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 20,
    marginTop: 12,
  },
  later: { fontSize: fontSize.small, color: colors.muted },
  button: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: colors.primary,
  },
  buttonPressed: { opacity: 0.8 },
  buttonText: { fontSize: fontSize.small, fontWeight: "700", color: colors.userText },
});
