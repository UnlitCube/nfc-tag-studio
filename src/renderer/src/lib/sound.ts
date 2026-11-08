// Feedback beeps via WebAudio (no audio assets). Integrator-owned.
import { useAppStore } from '../store/app';

let ctx: AudioContext | null = null;

function tone(freq: number, startMs: number, durMs: number, type: OscillatorType = 'sine', gain = 0.12) {
  if (!ctx) ctx = new AudioContext();
  const t0 = ctx.currentTime + startMs / 1000;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.setValueAtTime(gain, t0 + durMs / 1000 - 0.02);
  g.gain.linearRampToValueAtTime(0, t0 + durMs / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + durMs / 1000 + 0.02);
}

/** Play a feedback sound if enabled in settings. */
export function beep(kind: 'success' | 'error' | 'tap'): void {
  if (!useAppStore.getState().settings.sound) return;
  try {
    if (kind === 'success') {
      tone(1320, 0, 90);
      tone(1760, 110, 140);
    } else if (kind === 'error') {
      tone(220, 0, 380, 'square', 0.08);
    } else {
      tone(1000, 0, 60);
    }
  } catch {
    /* audio unavailable - ignore */
  }
}
