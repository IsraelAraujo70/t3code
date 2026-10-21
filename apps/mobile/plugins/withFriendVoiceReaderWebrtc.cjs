// Friend fork: the voice reader plays a Codex realtime voice over react-native-webrtc.
const { AndroidConfig, withMainApplication } = require("expo/config-plugins");

const MARKER = "friend-voice-reader-audio";

const IMPORTS = [
  "import android.media.AudioAttributes",
  "import com.oney.WebRTCModule.WebRTCModuleOptions",
  "import org.webrtc.audio.JavaAudioDeviceModule",
];

// WebRTC defaults to voice-call audio, which Android routes to the earpiece at call volume. The
// reader is something to listen to, so its output is media: loudspeaker or headphones, media volume.
const SETUP = `    // ${MARKER}
    WebRTCModuleOptions.getInstance().audioDeviceModule =
      JavaAudioDeviceModule.builder(this)
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build(),
        )
        .setEnableVolumeLogger(false)
        .createAudioDeviceModule()`;

/** Adds the main application's media-audio setup; a no-op when it is already there. */
function addAudioSetup(source) {
  if (source.includes(MARKER)) return source;
  const lines = source.split("\n");
  const packageLine = lines.findIndex((line) => line.startsWith("package "));
  if (packageLine === -1) throw new Error("MainApplication.kt has no package line.");
  lines.splice(packageLine + 1, 0, ...IMPORTS);
  const withImports = lines.join("\n");
  const anchor = "super.onCreate()";
  if (!withImports.includes(anchor)) throw new Error("MainApplication.kt has no super.onCreate().");
  return withImports.replace(anchor, `${anchor}\n${SETUP}`);
}

module.exports = function withFriendVoiceReaderWebrtc(config) {
  // RECORD_AUDIO comes from expo-audio: the reader sends a muted microphone track.
  config = AndroidConfig.Permissions.withPermissions(config, [
    "android.permission.ACCESS_NETWORK_STATE",
    "android.permission.INTERNET",
    "android.permission.MODIFY_AUDIO_SETTINGS",
  ]);
  return withMainApplication(config, (nextConfig) => {
    if (nextConfig.modResults.language !== "kt") {
      throw new Error("The voice reader's audio setup expects a Kotlin MainApplication.");
    }
    nextConfig.modResults.contents = addAudioSetup(nextConfig.modResults.contents);
    return nextConfig;
  });
};

module.exports.addAudioSetup = addAudioSetup;
