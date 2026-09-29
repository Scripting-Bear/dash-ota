import { useEffect, useRef, useState } from 'react';

/**
 * The update lifecycle as the client actually reports it. Each stop carries the real log line
 * the native layer writes on a cold start, so the rail doubles as a reading of `adb logcat -s
 * DashOta:W`. The failure track is the crash-loop breaker.
 */

type Stop = {
  key: string;
  label: string;
  note: string;
  log: string;
};

const HAPPY: Stop[] = [
  {
    key: 'check',
    label: 'Check',
    note: 'The app asks whether anything newer exists for its channel and runtime version.',
    log: 'launch: no stored bundle — using the embedded one',
  },
  {
    key: 'download',
    label: 'Download',
    note: 'Only the files this device does not already hold. Unchanged files are reused from the running bundle.',
    log: 'uploading: 4 of 121 blobs (117 already present)',
  },
  {
    key: 'verify',
    label: 'Verify',
    note: 'Ed25519 signature checked in native against the key compiled into the binary, then every file hash.',
    log: 'signature ok · 121/121 file hashes match',
  },
  {
    key: 'armed',
    label: 'Armed',
    note: 'Staged on disk and set to apply on the next cold start. Nothing swaps under a running app.',
    log: 'launch: staged bnd_rt_9f2c1a_2 — applying on next launch',
  },
  {
    key: 'applied',
    label: 'Applied',
    note: 'Running the new bundle, on trial. Two failed boots and it goes back.',
    log: 'launch: applying pending bnd_rt_9f2c1a_2 on trial (attempt 1/2)',
  },
  {
    key: 'healthy',
    label: 'Healthy',
    note: 'Your app called markHealthy() after the first usable screen. The trial is over.',
    log: 'confirm: healthy — lastKnownGood = bnd_rt_9f2c1a_2',
  },
];

const REVERTED: Stop = {
  key: 'reverted',
  label: 'Reverted',
  note: 'The bundle failed to reach JavaScript twice. It is blocklisted and the last good bundle is restored — without anyone paging you.',
  log: 'launch: crash loop: disabling bnd_rt_9f2c1a_2, reverting to bnd_rt_9f2c1a_1',
};

const TONE = {
  done: { dot: 'bg-steel', text: 'text-steel', ring: 'ring-steel/30' },
  active: { dot: 'bg-amber', text: 'text-amber', ring: 'ring-amber/40' },
  idle: { dot: 'bg-line', text: 'text-muted', ring: 'ring-transparent' },
  alarm: { dot: 'bg-alarm', text: 'text-alarm', ring: 'ring-alarm/40' },
};

export default function LifecycleRail() {
  const [index, setIndex] = useState(0);
  const [failing, setFailing] = useState(false);
  const [paused, setPaused] = useState(false);
  const reduced = useRef(false);

  useEffect(() => {
    reduced.current =
      typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  }, []);

  const stops = failing ? [...HAPPY.slice(0, 5), REVERTED] : HAPPY;

  useEffect(() => {
    if (paused || reduced.current) return undefined;
    const id = setInterval(() => setIndex((i) => (i + 1) % stops.length), 2600);
    return () => clearInterval(id);
  }, [paused, stops.length]);

  useEffect(() => {
    if (index > stops.length - 1) setIndex(stops.length - 1);
  }, [stops.length, index]);

  const current = stops[Math.min(index, stops.length - 1)];
  const isAlarmStop = current.key === 'reverted';

  return (
    <div
      className="w-full rounded-lg border border-line bg-panel shadow-panel"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">
          Update lifecycle
        </span>
        <button
          type="button"
          onClick={() => {
            setFailing((f) => !f);
            setIndex(failing ? 0 : 5);
          }}
          className={`rounded border px-2.5 py-1 font-mono text-[11px] transition-colors ${
            failing
              ? 'border-alarm/50 bg-alarm/10 text-alarm'
              : 'border-line text-muted hover:border-muted hover:text-ink'
          }`}
        >
          {failing ? 'crash-loop: on' : 'simulate a bad bundle'}
        </button>
      </div>

      <div className="px-4 pb-1 pt-5">
        <ol className="flex flex-wrap items-center gap-x-1 gap-y-3">
          {stops.map((stop, i) => {
            const state =
              stop.key === 'reverted' && i <= index
                ? 'alarm'
                : i === index
                  ? 'active'
                  : i < index
                    ? 'done'
                    : 'idle';
            const tone = TONE[state];
            return (
              <li key={stop.key} className="flex items-center">
                <button
                  type="button"
                  onClick={() => setIndex(i)}
                  aria-current={i === index}
                  className={`flex items-center gap-2 rounded px-2 py-1 ring-1 transition-all ${tone.ring} ${
                    i === index ? 'bg-raised' : 'bg-transparent hover:bg-raised/60'
                  }`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${tone.dot}`} />
                  <span
                    className={`font-display text-[13px] font-bold uppercase tracking-wide ${tone.text}`}
                  >
                    {stop.label}
                  </span>
                </button>
                {i < stops.length - 1 && (
                  <span
                    className={`mx-1 h-px w-5 ${i < index ? 'bg-steel/40' : 'bg-line'}`}
                    aria-hidden
                  />
                )}
              </li>
            );
          })}
        </ol>
      </div>

      <div className="px-4 pb-4 pt-3">
        <p className="min-h-[2.8em] text-[13.5px] leading-relaxed text-ink/80">{current.note}</p>
        <pre
          className={`mt-3 overflow-x-auto rounded border px-3 py-2 font-mono text-[11.5px] leading-relaxed ${
            isAlarmStop
              ? 'border-alarm/40 bg-alarm/[0.07] text-alarm'
              : 'border-line bg-body text-steel'
          }`}
        >
          {current.log}
        </pre>
      </div>
    </div>
  );
}
