import type { ExpoConfig } from "expo/config";

import { readFriendBuildInfo } from "../../scripts/friend/mobileBuildInfo.ts";

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
    // The app opens the system installer for its own updates (src/appUpdateDevice.ts).
    permissions: ["android.permission.REQUEST_INSTALL_PACKAGES"],
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
  // The commit this APK is built from, compared with the update the guest API publishes.
  extra: { friendBuild: readFriendBuildInfo() },
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
        microphonePermission: false,
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
