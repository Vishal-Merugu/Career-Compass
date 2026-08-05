import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  delay,
  apiDelay,
  connectionDelay,
  canSendConnection,
  getRemainingSlots,
} from './rateLimiter.js';
import type { IUserConfig, IDailyStats } from './types.js';

const config = (dailyLimit: number): IUserConfig =>
  ({ dailyLimit }) as IUserConfig;

const stats = (connectionsSent: number): IDailyStats =>
  ({ connectionsSent }) as IDailyStats;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('canSendConnection', () => {
  it('allows sends below the daily limit', () => {
    expect(canSendConnection(config(15), stats(14))).toBe(true);
  });

  it('blocks once the limit is reached', () => {
    expect(canSendConnection(config(15), stats(15))).toBe(false);
  });

  it('blocks when already over the limit', () => {
    expect(canSendConnection(config(15), stats(99))).toBe(false);
  });

  it('defaults to 15 when dailyLimit is missing', () => {
    expect(canSendConnection({} as IUserConfig, stats(14))).toBe(true);
    expect(canSendConnection({} as IUserConfig, stats(15))).toBe(false);
  });

  it('treats dailyLimit 0 as 15 — documents the `|| 15` fallback', () => {
    // `config.dailyLimit || 15` cannot distinguish "unset" from "deliberately
    // zero", so a user who sets 0 to pause sending still gets 15 slots. Pinned
    // here so the behaviour cannot change silently; see tasks/lessons.md.
    expect(canSendConnection(config(0), stats(0))).toBe(true);
    expect(getRemainingSlots(config(0), stats(0))).toBe(15);
  });
});

describe('getRemainingSlots', () => {
  it('returns the unused slots', () => {
    expect(getRemainingSlots(config(15), stats(4))).toBe(11);
  });

  it('never returns a negative number', () => {
    expect(getRemainingSlots(config(15), stats(20))).toBe(0);
  });

  it('returns the full limit when nothing has been sent', () => {
    expect(getRemainingSlots(config(10), stats(0))).toBe(10);
  });
});

describe('delay', () => {
  it('waits within [min, max] inclusive', async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    void delay(1000, 2000);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.anything(), 1000);

    // Math.random() is exclusive of 1, so 0.999… is the practical ceiling.
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    void delay(1000, 2000);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.anything(), 2000);

    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    void delay(1000, 2000);
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.anything(), 1500);
  });

  it('resolves after the timer fires', async () => {
    vi.useFakeTimers();
    let done = false;
    const pending = delay(1000, 1000).then(() => {
      done = true;
    });
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await pending;
    expect(done).toBe(true);
  });
});

describe('pacing presets', () => {
  it('apiDelay stays in the 1.5–3.7 s human-like band', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    void apiDelay();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.anything(), 1500);

    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    void apiDelay();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.anything(), 3700);
  });

  it('connectionDelay stays in the 5–10 s band', () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    vi.spyOn(Math, 'random').mockReturnValue(0);
    void connectionDelay();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.anything(), 5000);

    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    void connectionDelay();
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.anything(), 10000);
  });
});
