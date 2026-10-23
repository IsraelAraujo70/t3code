import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { listBots } from "./api";
import { parsePairing, type Pairing } from "./pairing";
import { savePairing } from "./storage";
import { colors, fontSize } from "./theme";

const INVALID_CODE =
  "Esse código não parece certo. Escaneie o QR code de novo ou peça um novo para quem te convidou.";

export function PairingScreen(props: {
  /** A `t3guest://pair` link that opened the app; it connects right away. */
  readonly link: string | null;
  readonly notice: string | null;
  readonly onPaired: (pairing: Pairing) => void;
  readonly onCancel: (() => void) | null;
}) {
  const { onPaired } = props;
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState(props.link ?? "");
  const [error, setError] = useState<string | null>(props.notice);
  const [connecting, setConnecting] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const busy = useRef(false);

  const connect = useCallback(
    async (text: string) => {
      if (busy.current) return;
      const pairing = parsePairing(text);
      if (pairing === null) {
        setError(INVALID_CODE);
        return;
      }
      busy.current = true;
      setScanning(false);
      setConnecting(true);
      setError(null);
      try {
        await listBots(pairing);
        await savePairing(pairing);
        onPaired(pairing);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Não consegui conectar.");
      } finally {
        busy.current = false;
        setConnecting(false);
      }
    },
    [onPaired],
  );

  useEffect(() => {
    if (props.link !== null) void connect(props.link);
  }, [props.link, connect]);

  const startScanning = async () => {
    setError(null);
    const granted = permission?.granted || (await requestPermission()).granted;
    if (granted) setScanning(true);
    else setError("Sem acesso à câmera. Você pode colar o código no campo abaixo.");
  };

  const onScanned = (result: BarcodeScanningResult) => {
    if (busy.current) return;
    setCode(result.data);
    void connect(result.data);
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior="padding">
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + 32, paddingBottom: insets.bottom + 24 },
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.hello}>Oi, Bia! 💛</Text>
        <Text style={styles.lead}>
          Vamos conectar você aos seus assistentes. É só escanear o QR code que você recebeu.
        </Text>

        {scanning ? (
          <View style={styles.cameraBox}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={connecting ? undefined : onScanned}
            />
          </View>
        ) : null}

        <Pressable
          style={[styles.primary, connecting && styles.disabled]}
          disabled={connecting}
          onPress={() => (scanning ? setScanning(false) : void startScanning())}
        >
          <Text style={styles.primaryText}>
            {scanning ? "Fechar câmera" : "📷  Escanear QR code"}
          </Text>
        </Pressable>

        <Text style={styles.or}>ou cole o código aqui</Text>
        <TextInput
          style={styles.input}
          value={code}
          onChangeText={setCode}
          placeholder="t3guest://pair?..."
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
        />
        <Pressable
          style={[styles.secondary, (connecting || code.trim().length === 0) && styles.disabled]}
          disabled={connecting || code.trim().length === 0}
          onPress={() => void connect(code)}
        >
          {connecting ? (
            <ActivityIndicator color={colors.primary} />
          ) : (
            <Text style={styles.secondaryText}>Conectar</Text>
          )}
        </Pressable>

        {error !== null ? <Text style={styles.error}>{error}</Text> : null}

        {props.onCancel !== null ? (
          <Pressable style={styles.cancel} onPress={props.onCancel}>
            <Text style={styles.cancelText}>Voltar</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 24, gap: 16 },
  hello: { fontSize: 36, fontWeight: "800", color: colors.text },
  lead: { fontSize: fontSize.body, lineHeight: 27, color: colors.muted },
  cameraBox: {
    height: 300,
    borderRadius: 24,
    overflow: "hidden",
    backgroundColor: colors.text,
  },
  primary: {
    backgroundColor: colors.primary,
    borderRadius: 18,
    paddingVertical: 18,
    alignItems: "center",
  },
  primaryText: { color: colors.userText, fontSize: fontSize.large, fontWeight: "700" },
  or: { textAlign: "center", fontSize: fontSize.small, color: colors.muted, marginTop: 8 },
  input: {
    minHeight: 64,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    padding: 14,
    fontSize: fontSize.small,
    color: colors.text,
  },
  secondary: {
    borderRadius: 18,
    borderWidth: 2,
    borderColor: colors.primary,
    paddingVertical: 16,
    alignItems: "center",
  },
  secondaryText: { color: colors.primary, fontSize: fontSize.large, fontWeight: "700" },
  disabled: { opacity: 0.5 },
  error: {
    padding: 14,
    borderRadius: 14,
    backgroundColor: colors.primarySoft,
    color: colors.danger,
    fontSize: fontSize.body,
    lineHeight: 25,
  },
  cancel: { alignItems: "center", padding: 12 },
  cancelText: { color: colors.muted, fontSize: fontSize.body },
});
