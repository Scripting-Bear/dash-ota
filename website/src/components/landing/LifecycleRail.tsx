import { useEffect, useRef, useState } from 'react';

/**
 * The update lifecycle as the client reports it. Each stop carries a real log line from an
 * end-to-end run: `launch:` lines come from native code (Android tag `DashOta`, iOS subsystem
 * `dash-ota`), `[dash-ota]` lines from the JS provider's default logger. The failure track is
 * the crash-loop breaker.
 */

type Stop = {
  key: string;
  label: string;
  note: string;
  log: string;
  alarm?: boolean;
};

const HAPPY: Stop[] = [
  {
    key: 'embedded',
    label: 'Embedded',
    note: 'A fresh install runs the bundle compiled into the app.',
    log: 'launch: no stored bundle — using the embedded one',
  },
  {
    key: 'check',
    label: 'Check',
    note: 'On its first check the app enrolls a device key, then asks whether a newer release exists for its channel and runtime version.',
    log: '[dash-ota] enrolled device key',
  },
  {
    key: 'staged',
    label: 'Staged',
    note: 'Native code verifies the release signature against the keys compiled into the app before writing anything, then fetches only the files this device doesn’t already hold and checks each hash. Nothing swaps under a running app.',
    log: '[dash-ota] staged bnd_rt1_2_mumketyh v2',
  },
  {
    key: 'applied',
    label: 'Applied',
    note: 'The next cold start runs the new bundle on trial. That launch is attempt 1 of 2.',
    log: 'launch: applying pending bnd_rt1_2_mumketyh on trial (attempt 1/2)',
  },
  {
    key: 'reported',
    label: 'Reported',
    note: 'The app tells the server the bundle applied. Those reports feed adoption and auto-pause.',
    log: '[dash-ota] reporting applied bnd_rt1_2_mumketyh',
  },
  {
    key: 'healthy',
    label: 'Healthy',
    note: 'Your app called markHealthy() once its first real screen worked, which ended the trial. From the next launch it runs as the last working bundle.',
    log: 'launch: bnd_rt1_2_mumketyh (healthy)',
  },
];

const FAILING: Stop[] = [
  {
    key: 'applied-bad',
    label: 'Applied',
    note: 'A later release starts its trial on the next cold start.',
    log: 'launch: applying pending bnd_rt1_3_mumksul0 on trial (attempt 1/2)',
  },
  {
    key: 'charged',
    label: 'Charged',
    note: 'The first launch crashed, so this one counts: attempt 2 of 2. A session that reached JavaScript and then went to the background would not have counted.',
    log: 'launch: bnd_rt1_3_mumksul0 on trial, attempt 2/2',
  },
  {
    key: 'reverted',
    label: 'Reverted',
    note: 'The third launch finds the trial still open. The bundle is disabled on this device and the last working bundle runs again, on trial itself, with the embedded bundle behind it.',
    log: 'launch: crash loop: disabling bnd_rt1_3_mumksul0, reverting to bnd_rt1_2_mumketyh on trial',
    alarm: true,
  },
  {
    key: 'failure-reported',
    label: 'Reported',
    note: 'The app reports the failure on its next check. Once enough devices report failures, the server pauses the release for everyone else.',
    log: '[dash-ota] reporting crash-loop failure of bnd_rt1_3_mumksul0',
    alarm: true,
  },
];

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

  const stops = failing ? FAILING : HAPPY;

  useEffect(() => {
    if (paused || reduced.current) return undefined;
    const id = setInterval(() => setIndex((i) => (i + 1) % stops.length), 2600);
    return () => clearInterval(id);
  }, [paused, stops.length]);

  useEffect(() => {
    if (index > stops.length - 1) setIndex(stops.length - 1);
  }, [stops.length, index]);

  const current = stops[Math.min(index, stops.length - 1)];
  const isAlarmStop = Boolean(current.alarm);

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
            setIndex(failing ? 0 : FAILING.findIndex((stop) => stop.key === 'reverted'));
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
              stop.alarm && i <= index
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
