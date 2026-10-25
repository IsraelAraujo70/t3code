import type { ExpoConfig } from "expo/config";

const PINK = "#F27896";
const googleServicesFile = process.env.BIA_ANDROID_GOOGLE_SERVICES_FILE?.trim();

const config: ExpoConfig = {
  name: "Bia",
  slug: "bia",
  version: "1.0.0",
  platforms: ["android", "ios"],
  // Scanning the pairing QR with the phone's own camera opens the app through this scheme.
  scheme: "t3guest",
  orientation: "portrait",
  userInterfaceStyle: "light",
  icon: "./assets/icon.png",
  android: {
    package: "com.israelaraujo.bia",
    ...(googleServicesFile ? { googleServicesFile } : {}),
    adaptiveIcon: {
      backgroundColor: PINK,
      foregroundImage: "./assets/adaptive-icon.png",
      monochromeImage: "./assets/adaptive-icon.png",
    },
  },
  ios: {
    bundleIdentifier: "com.israelaraujo.bia",
  },
  plugins: [
    "expo-secure-store",
    [
      "expo-camera",
      {
        cameraPermission: "Permita o acesso à câmera para ler o QR code e tirar fotos.",
        microphonePermission: false,
        recordAudioAndroid: false,
        barcodeScannerEnabled: true,
      },
    ],
    [
      "expo-image-picker",
      {
        photosPermission: "Permita o acesso às fotos para enviar imagens aos seus assistentes.",
        cameraPermission: "Permita o acesso à câmera para ler o QR code e tirar fotos.",
        // A string, not `false`: `false` blocks RECORD_AUDIO, which the voice conversation needs.
        microphonePermission: "Permita o acesso ao microfone para conversar por voz.",
      },
    ],
    [
      "expo-notifications",
      {
        icon: "./assets/notification-icon.png",
        color: PINK,
        defaultChannel: "respostas",
      },
    ],
    // The voice plays as media (loudspeaker, media volume), with the same setup as T3's app.
    "../mobile/plugins/withFriendVoiceReaderWebrtc.cjs",
    [
      "expo-build-properties",
      {
        android: {
          minSdkVersion: 24,
          // The server is plain http on a Tailscale IP (or 10.0.2.2 on the emulator).
          usesCleartextTraffic: true,
        },
      },
    ],
  ],
};

export default config;
