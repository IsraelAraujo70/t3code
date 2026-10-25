import { View } from "react-native";
import Animated, { FadeIn, FadeOut, ReduceMotion } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ListActionRow } from "../components/ui/ListActionRow";
import { ListRowLayout } from "../components/ui/ListRowLayout";
import { ListSection } from "../components/ui/ListSection";
import { Toast } from "../components/ui/Toast";
import { MOBILE_MOTION } from "../lib/designTokens";
import { APP_BAR_HEIGHT } from "../lib/layoutMetrics";
import {
  isUpdateAvailable,
  type SelfUpdatePhase,
  type SelfUpdateSnapshot,
} from "@t3tools/client-runtime/app-self-update";
import { selfUpdate, useSelfUpdate, useSelfUpdateChecks } from "./selfUpdate";

const short = (commit: string) => commit.slice(0, 10);
const day = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
};

function busyLabel(phase: SelfUpdatePhase): string | null {
  switch (phase.type) {
    case "downloading":
      return phase.fraction === null
        ? "Baixando a atualização…"
        : `Baixando a atualização… ${Math.round(phase.fraction * 100)}%`;
    case "verifying":
      return "Conferindo o APK…";
    case "installing":
      return "Abrindo o instalador…";
    default:
      return null;
  }
}

/**
 * Checks for a new APK and shows a small notice under the app bar while one is available or
 * downloading. Mounted once at the app root; renders nothing in builds without an embedded commit.
 */
export function SelfUpdateNotice() {
  useSelfUpdateChecks();
  const snapshot = useSelfUpdate();
  const insets = useSafeAreaInsets();
  const busy = busyLabel(snapshot.phase);
  const offered =
    isUpdateAvailable(snapshot.embedded, snapshot.latest) &&
    snapshot.dismissedCommit !== snapshot.latest.commit;
  if (busy === null && !offered) return null;
  return (
    <Animated.View
      entering={FadeIn.duration(MOBILE_MOTION.enter).reduceMotion(ReduceMotion.System)}
      exiting={FadeOut.duration(MOBILE_MOTION.exit).reduceMotion(ReduceMotion.System)}
      className="absolute inset-x-3 z-[100]"
      style={{ top: insets.top + APP_BAR_HEIGHT + 8 }}
      pointerEvents="box-none"
    >
      {busy !== null ? (
        <Toast message={busy} busy />
      ) : (
        <Toast
          message="Atualização disponível"
          description={
            snapshot.latest ? `Versão ${snapshot.latest.shortCommit} do servidor` : undefined
          }
          action={{ label: "Atualizar", onPress: () => void selfUpdate.install() }}
          onDismiss={selfUpdate.dismiss}
        />
      )}
    </Animated.View>
  );
}

function versionLabel(snapshot: SelfUpdateSnapshot): string {
  if (snapshot.checkedAt === null) return "Ainda não verificada";
  if (snapshot.latest === null) return "Nada publicado no servidor";
  return `${snapshot.latest.shortCommit} · ${day(snapshot.latest.commitDate)}`;
}

/** Settings → App update: the running and published versions, and the update button. */
export function SelfUpdateSettingsSection() {
  const snapshot = useSelfUpdate();
  if (snapshot.embedded === null) return null;
  const busy = busyLabel(snapshot.phase);
  const available = isUpdateAvailable(snapshot.embedded, snapshot.latest);
  return (
    <ListSection
      title="Atualização do app"
      footer={
        snapshot.error ??
        "Na primeira atualização o Android pede para permitir que o T3 Code instale apps."
      }
    >
      <View className="bg-grouped-card">
        <ListRowLayout
          icon="info.circle"
          label="Versão instalada"
          description={`${short(snapshot.embedded.commit)} · ${day(snapshot.embedded.commitDate)}`}
        />
      </View>
      <View className="bg-grouped-card">
        <ListRowLayout
          icon="arrow.down.circle"
          label="Versão no servidor"
          description={versionLabel(snapshot)}
        />
      </View>
      {available ? (
        <ListActionRow
          icon="arrow.down"
          label={busy ?? "Atualizar agora"}
          loading={busy !== null}
          onPress={() => void selfUpdate.install()}
        />
      ) : (
        <ListActionRow
          icon="arrow.clockwise"
          label={snapshot.phase.type === "checking" ? "Verificando…" : "Verificar agora"}
          loading={snapshot.phase.type === "checking"}
          onPress={() => void selfUpdate.check("manual")}
        />
      )}
    </ListSection>
  );
}
