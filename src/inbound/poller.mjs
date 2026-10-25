const SECOND = 1000;
const NOTICE_TITLE = 'Basecamp: sync';
const SKIP_AFTER_THRESHOLD = 1;
const SKIP_AFTER_REPEATED = 3;

/** A tick failed when the Orca list or the host failed, or when every item it attempted failed. */
const tickFailed = (result) =>
  result.status === 'orca_failed' || result.status === 'failed' || (result.attempted > 0 && result.failed === result.attempted);

/**
 * Drives `tick()` from an unref'd interval. A tick never overlaps another. After `threshold` failed ticks in a row
 * it skips 1 interval, from the next failure on 3 (so the gap stays under the host's 5-minute idle reap).
 * A fatal tick result stops the poller and blocks restarts for `fatalCooldownMs`; `runNow` bypasses the block.
 * `ensureStarted` is synchronous and O(1), so it is safe inside an event handler.
 */
export function createPoller({
  tick,
  onNotice,
  timers = { setInterval, clearInterval, setTimeout, clearTimeout },
  clock = { now: () => Date.now() },
  intervalMs = 60 * SECOND,
  initialDelayMs = 5 * SECOND,
  threshold = 3,
  fatalCooldownMs = 600 * SECOND
}) {
  let interval = null;
  let initial = null;
  let inflight = null;
  let failures = 0;
  let skip = 0;
  let fatalUntil = 0;
  let backoffNoticed = false;
  let fatalNoticed = false;

  const notice = async (body) => {
    try {
      await onNotice(NOTICE_TITLE, body);
    } catch {
      // a failed notification must not break the loop
    }
  };

  function clearTimers() {
    if (interval !== null) timers.clearInterval(interval);
    if (initial !== null) timers.clearTimeout(initial);
    interval = null;
    initial = null;
  }

  async function settle(result) {
    if (result.fatal) {
      clearTimers();
      fatalUntil = clock.now() + fatalCooldownMs;
      if (!fatalNoticed) await notice(`Sync stopped: ${result.fatal.message}. It will retry on its own in 10 minutes, or run "Sync now".`);
      fatalNoticed = true;
      return;
    }
    if (!tickFailed(result)) {
      failures = 0;
      skip = 0;
      backoffNoticed = false;
      fatalNoticed = false;
      return;
    }
    failures += 1;
    if (failures >= threshold) {
      skip = failures === threshold ? SKIP_AFTER_THRESHOLD : SKIP_AFTER_REPEATED;
      if (!backoffNoticed) await notice(`Sync is failing; retrying less often (${failures} failed ticks in a row).`);
      backoffNoticed = true;
    }
  }

  function runTick() {
    inflight ??= (async () => {
      let result;
      try {
        result = (await tick()) ?? { status: 'failed' };
      } catch {
        result = { status: 'failed' };
      }
      await settle(result);
      return result;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function begin({ withInitialTick }) {
    if (interval !== null) return;
    interval = timers.setInterval(() => {
      if (inflight) return;
      if (skip > 0) {
        skip -= 1;
        return;
      }
      void runTick();
    }, intervalMs);
    interval.unref?.();
    if (withInitialTick) {
      initial = timers.setTimeout(() => {
        initial = null;
        void runTick();
      }, initialDelayMs);
      initial.unref?.();
    }
  }

  return {
    /** Starts unless running or inside the fatal cooldown. Returns whether the poller is running. */
    ensureStarted() {
      if (interval === null && clock.now() >= fatalUntil) begin({ withInitialTick: true });
      return interval !== null;
    },
    /** Starts regardless of the fatal cooldown. */
    start() {
      fatalUntil = 0;
      begin({ withInitialTick: true });
    },
    /** Exactly one immediate tick (joins one already running); starts the interval if stopped. */
    runNow() {
      fatalUntil = 0;
      begin({ withInitialTick: false });
      if (initial !== null) {
        timers.clearTimeout(initial);
        initial = null;
      }
      return runTick();
    },
    stop: clearTimers,
    isRunning: () => interval !== null
  };
}
