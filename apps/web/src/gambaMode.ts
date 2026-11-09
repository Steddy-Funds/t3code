import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";

import { countFinishedTurns, type TurnTallies } from "./gambaMode.logic";
import { getClientSettings, subscribeClientSettings } from "./hooks/useSettings";
import { environmentSummaries } from "./state/presentation";
import { environmentShell } from "./state/shell";
import { loadAudioBuffer, runningAudioContext, unlockAudio } from "./threadNotifications";

// Hosted outside the repo: the fork is public and the sample is not ours to redistribute.
const coinUrl =
  "https://gu6ywarijp2qlgc0.public.blob.vercel-storage.com/gamba/mario-party-ds-coin.mp3";

/** The game's coin counter ticks one coin per 8 frames, so a burst plays as a deposit. */
const COIN_SPACING_SECONDS = 0.1338;
/** At most a 20-coin deposit waits to play, so the sound stays current. */
const MAX_COIN_BACKLOG_SECONDS = 20 * COIN_SPACING_SECONDS;

let nextCoinAt = 0;

async function playCoins(count: number, { preview = false } = {}) {
  const context = runningAudioContext();
  if (!context) return;
  try {
    const decoded = await loadAudioBuffer(context, coinUrl);
    const { gambaModeEnabled, gambaModeVolume } = getClientSettings();
    if (!gambaModeEnabled || context.state !== "running") return;
    // A slider drag previews only while no coin is waiting, so it never builds a backlog.
    if (preview && nextCoinAt > context.currentTime) return;
    // Squared, so the slider tracks perceived loudness rather than amplitude.
    const gain = new GainNode(context, { gain: (gambaModeVolume / 100) ** 2 });
    gain.connect(context.destination);
    for (let coin = 0; coin < count; coin += 1) {
      const startAt = Math.max(context.currentTime, nextCoinAt);
      if (startAt - context.currentTime > MAX_COIN_BACKLOG_SECONDS) return;
      const source = context.createBufferSource();
      source.buffer = decoded;
      source.connect(gain);
      source.start(startAt);
      nextCoinAt = startAt + COIN_SPACING_SECONDS;
    }
  } catch {
    // A failed load is retried on the next coin.
  }
}

const unlockCoin = () => unlockAudio([coinUrl]);

/** One coin at the current volume, for the settings slider. Called from its gesture. */
export function previewGambaCoin() {
  unlockCoin();
  void playCoins(1, { preview: true });
}

/** Plays a coin each time any agent turn completes, subagents included, on every connected environment. */
export function startGambaMode(registry: AtomRegistry.AtomRegistry): () => void {
  const watched = new Map<EnvironmentId, () => void>();

  const watchEnvironment = (environmentId: EnvironmentId) => {
    let tallies: TurnTallies | null = null;
    return registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
          tallies = null;
          return;
        }
        const result = countFinishedTurns(tallies, shell.snapshot.value.threads);
        tallies = result.tallies;
        if (result.coins > 0) void playCoins(result.coins);
      },
      { immediate: true },
    );
  };

  let enabled = false;
  const sync = () => {
    const nextEnabled = getClientSettings().gambaModeEnabled;
    if (nextEnabled !== enabled) {
      enabled = nextEnabled;
      if (enabled) {
        document.addEventListener("pointerdown", unlockCoin);
        document.addEventListener("keydown", unlockCoin);
      } else {
        document.removeEventListener("pointerdown", unlockCoin);
        document.removeEventListener("keydown", unlockCoin);
      }
    }
    const environmentIds = new Set(
      enabled ? registry.get(environmentSummaries.environmentIdsAtom) : [],
    );
    for (const [environmentId, unsubscribe] of watched) {
      if (environmentIds.has(environmentId)) continue;
      unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const unsubscribeSettings = subscribeClientSettings(sync);
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    sync,
  );
  sync();

  return () => {
    unsubscribeSettings();
    unsubscribeEnvironmentIds();
    for (const unsubscribe of watched.values()) unsubscribe();
    watched.clear();
    document.removeEventListener("pointerdown", unlockCoin);
    document.removeEventListener("keydown", unlockCoin);
  };
}
