import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";

import { countFinishedTurns, type TurnTallies } from "./gambaMode.logic";
import { getClientSettings, subscribeClientSettings } from "./hooks/useSettings";
import { environmentSummaries } from "./state/presentation";
import { environmentShell } from "./state/shell";
import { loadAudioBuffer, runningAudioContext, unlockAudio } from "./threadNotifications";

// Hosted outside the repo: the fork is public and the sample is not ours to redistribute.
// The DS rip with its 4-bit ADPCM hiss masked out between the coin's partials.
const coinUrl =
  "https://gu6ywarijp2qlgc0.public.blob.vercel-storage.com/gamba/mario-party-ds-coin-clean-wRV8FtraZcdMfSNMiH5nRYm6J4kzA3.mp3";

/** The game's coin counter ticks one coin per 8 frames, so a burst plays as a deposit. */
const COIN_SPACING_SECONDS = 0.1338;
/** At most a 20-coin deposit waits to play, so the sound stays current. */
const MAX_COIN_BACKLOG_SECONDS = 20 * COIN_SPACING_SECONDS;

/** Rounds off each coin's click. */
const ATTACK_SECONDS = 0.006;
const ROOM_MIX = 0.08;
const ROOM_DECAY_SECONDS = 0.5;

let nextCoinAt = 0;
let voice: {
  readonly context: AudioContext;
  readonly input: AudioNode;
  readonly volume: GainNode;
} | null = null;

/** Decaying noise, a small room that sits the coin behind whatever else is playing. */
function roomImpulse(context: AudioContext) {
  const length = Math.floor(context.sampleRate * ROOM_DECAY_SECONDS);
  const impulse = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    let seed = 1234 + channel * 77;
    for (let i = 0; i < length; i += 1) {
      seed = (seed * 16807) % 2147483647;
      data[i] = ((seed / 2147483647) * 2 - 1) * (1 - i / length) ** 3;
    }
  }
  return impulse;
}

/**
 * The "soft" voicing tuned for background listening: less of the tinny 3 kHz bell and top end,
 * a touch of body and room. Built once per context; silent filters skip processing between coins.
 */
function voiceFor(context: AudioContext) {
  if (voice?.context === context) return voice;
  const volume = new GainNode(context);
  volume.connect(context.destination);
  const body = new BiquadFilterNode(context, { type: "lowshelf", frequency: 300, gain: 2 });
  const lowpass = new BiquadFilterNode(context, { type: "lowpass", frequency: 9000, Q: -3 });
  body
    .connect(new BiquadFilterNode(context, { type: "peaking", frequency: 3300, gain: -6, Q: 1.2 }))
    .connect(new BiquadFilterNode(context, { type: "highshelf", frequency: 6000, gain: -6 }))
    .connect(lowpass);
  lowpass.connect(new GainNode(context, { gain: 1 - ROOM_MIX })).connect(volume);
  lowpass
    .connect(new ConvolverNode(context, { buffer: roomImpulse(context) }))
    .connect(new GainNode(context, { gain: ROOM_MIX }))
    .connect(volume);
  voice = { context, input: body, volume };
  return voice;
}

async function playCoins(count: number, { preview = false } = {}) {
  const context = runningAudioContext();
  if (!context) return;
  try {
    const decoded = await loadAudioBuffer(context, coinUrl);
    const { gambaModeEnabled, gambaModeVolume } = getClientSettings();
    if (!gambaModeEnabled || context.state !== "running") return;
    // A slider drag previews only while no coin is waiting, so it never builds a backlog.
    if (preview && nextCoinAt > context.currentTime) return;
    const { input, volume } = voiceFor(context);
    // Squared, so the slider tracks perceived loudness rather than amplitude.
    volume.gain.value = (gambaModeVolume / 100) ** 2;
    for (let coin = 0; coin < count; coin += 1) {
      const startAt = Math.max(context.currentTime, nextCoinAt);
      if (startAt - context.currentTime > MAX_COIN_BACKLOG_SECONDS) return;
      const source = new AudioBufferSourceNode(context, { buffer: decoded });
      const attack = new GainNode(context, { gain: 0 });
      attack.gain.setValueAtTime(0, startAt);
      attack.gain.linearRampToValueAtTime(1, startAt + ATTACK_SECONDS);
      source.connect(attack).connect(input);
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
