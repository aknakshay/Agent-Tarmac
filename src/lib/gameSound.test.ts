import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isMuted, playGameSound, setMuted, setSynths } from "./gameSound";

function mockLocalStorage() {
  const store = new Map<string, string>();
  const mock: Storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  };
  vi.stubGlobal("localStorage", mock);
  return mock;
}

describe("mute persistence", () => {
  beforeEach(() => {
    mockLocalStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults to unmuted", () => {
    expect(isMuted()).toBe(false);
  });

  it("round-trips a mute toggle through storage", () => {
    setMuted(true);
    expect(isMuted()).toBe(true);
    setMuted(false);
    expect(isMuted()).toBe(false);
  });

  it("falls back to unmuted when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(isMuted()).toBe(false);
    expect(() => setMuted(true)).not.toThrow();
  });
});

describe("playGameSound dispatcher", () => {
  beforeEach(() => {
    mockLocalStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    setSynths();
  });

  it("invokes the synth for a given sound when unmuted", () => {
    const shoot = vi.fn();
    setSynths({ shoot });
    setMuted(false);
    playGameSound("shoot");
    expect(shoot).toHaveBeenCalledTimes(1);
  });

  it("never invokes any synth while muted", () => {
    const shoot = vi.fn();
    const explosion = vi.fn();
    const waveClear = vi.fn();
    setSynths({ shoot, explosion, waveClear });
    setMuted(true);
    playGameSound("shoot");
    playGameSound("explosion");
    playGameSound("waveClear");
    expect(shoot).not.toHaveBeenCalled();
    expect(explosion).not.toHaveBeenCalled();
    expect(waveClear).not.toHaveBeenCalled();
  });

  it("never throws even if a synth throws", () => {
    setSynths({
      shoot: () => {
        throw new Error("audio context unavailable");
      },
    });
    setMuted(false);
    expect(() => playGameSound("shoot")).not.toThrow();
  });
});
