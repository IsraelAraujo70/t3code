import type { GuestImageUpload } from "@t3tools/contracts";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { imageUpload, LIMITS } from "./images";
import { colors, fontSize } from "./theme";

export interface PickedImage {
  readonly uri: string;
  readonly upload: GuestImageUpload;
}

export interface Draft {
  readonly text: string;
  readonly images: readonly PickedImage[];
}

const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: "images",
  quality: 0.7,
  base64: true,
};

function toPicked(assets: readonly ImagePicker.ImagePickerAsset[], offset: number): PickedImage[] {
  const picked: PickedImage[] = [];
  for (const [index, asset] of assets.entries()) {
    if (!asset.base64) continue;
    const result = imageUpload({
      base64: asset.base64,
      fileName: asset.fileName,
      index: offset + index,
    });
    if (result.ok) picked.push({ uri: asset.uri, upload: result.upload });
    else Alert.alert("Não deu para usar essa foto", result.error);
  }
  return picked;
}

/**
 * Text box, photo button and send button. `onSend` resolves once the server took the message;
 * if it rejects, the draft comes back so nothing Bia wrote is lost.
 */
export function Composer(props: {
  readonly bottomInset: number;
  readonly onSend: (draft: Draft) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [images, setImages] = useState<readonly PickedImage[]>([]);
  const [sending, setSending] = useState(false);
  const remaining = LIMITS.attachments - images.length;
  const canSend = !sending && (text.trim().length > 0 || images.length > 0);

  const addFrom = async (source: "gallery" | "camera") => {
    if (source === "camera") {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Câmera bloqueada", "Permita o uso da câmera nas configurações do celular.");
        return;
      }
    }
    const result =
      source === "camera"
        ? await ImagePicker.launchCameraAsync(PICKER_OPTIONS)
        : await ImagePicker.launchImageLibraryAsync({
            ...PICKER_OPTIONS,
            allowsMultipleSelection: true,
            selectionLimit: remaining,
          });
    if (result.canceled) return;
    const picked = toPicked(result.assets.slice(0, remaining), images.length);
    setImages((current) => [...current, ...picked].slice(0, LIMITS.attachments));
  };

  const pick = (source: "gallery" | "camera") => {
    addFrom(source).catch(() =>
      Alert.alert("Não deu para abrir as fotos", "Tente de novo em instantes."),
    );
  };

  const choosePhoto = () => {
    if (remaining <= 0) {
      Alert.alert("Limite de fotos", `Dá para mandar até ${LIMITS.attachments} fotos por vez.`);
      return;
    }
    Alert.alert("Enviar foto", undefined, [
      { text: "Galeria", onPress: () => pick("gallery") },
      { text: "Câmera", onPress: () => pick("camera") },
      { text: "Cancelar", style: "cancel" },
    ]);
  };

  const send = async () => {
    if (!canSend) return;
    const draft: Draft = { text: text.trim(), images };
    setSending(true);
    setText("");
    setImages([]);
    try {
      await props.onSend(draft);
    } catch (error) {
      setText((current) => current || draft.text);
      setImages((current) => (current.length > 0 ? current : draft.images));
      Alert.alert(
        "Não consegui enviar",
        error instanceof Error ? error.message : "Tente de novo em instantes.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={[styles.container, { paddingBottom: props.bottomInset + 8 }]}>
      {images.length > 0 ? (
        <View style={styles.thumbs}>
          {images.map((image) => (
            <View key={image.uri}>
              <Image source={{ uri: image.uri }} style={styles.thumb} contentFit="cover" />
              <Pressable
                accessibilityLabel="Remover foto"
                hitSlop={8}
                style={styles.remove}
                onPress={() => setImages((current) => current.filter((item) => item !== image))}
              >
                <Text style={styles.removeText}>✕</Text>
              </Pressable>
            </View>
          ))}
        </View>
      ) : null}
      <View style={styles.row}>
        <Pressable
          accessibilityLabel="Adicionar foto"
          style={styles.iconButton}
          onPress={choosePhoto}
          disabled={sending}
        >
          <Text style={styles.icon}>📎</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Escreva sua mensagem…"
          placeholderTextColor={colors.muted}
          multiline
          maxLength={LIMITS.text}
          editable={!sending}
        />
        <Pressable
          accessibilityLabel="Enviar"
          style={[styles.send, !canSend && styles.sendDisabled]}
          onPress={() => void send()}
          disabled={!canSend}
        >
          {sending ? (
            <ActivityIndicator color={colors.userText} />
          ) : (
            <Text style={styles.sendText}>➤</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingHorizontal: 10,
    paddingTop: 8,
    gap: 8,
  },
  thumbs: { flexDirection: "row", gap: 8, paddingHorizontal: 4 },
  thumb: { width: 64, height: 64, borderRadius: 12 },
  remove: {
    position: "absolute",
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.text,
    alignItems: "center",
    justifyContent: "center",
  },
  removeText: { color: colors.userText, fontSize: 13, fontWeight: "700" },
  row: { flexDirection: "row", alignItems: "flex-end", gap: 8 },
  iconButton: { width: 44, height: 48, alignItems: "center", justifyContent: "center" },
  icon: { fontSize: 24 },
  input: {
    flex: 1,
    minHeight: 48,
    maxHeight: 160,
    borderRadius: 24,
    backgroundColor: colors.background,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: fontSize.body,
    color: colors.text,
  },
  send: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  sendDisabled: { opacity: 0.4 },
  sendText: { color: colors.userText, fontSize: 20 },
});
