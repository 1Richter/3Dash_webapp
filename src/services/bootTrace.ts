/**
 * Boot diagnostics — why did the app reload, and where did boot time go?
 *
 * Every programmatic `window.location.reload()` should go through
 * `reloadWithReason()` so the next boot can surface what happened. The
 * dashboard shows a one-line summary toast after the model is up, which
 * makes load-time regressions diagnosable on devices without a console
 * (phone WebViews inside the HA companion app).
 */

const RELOAD_KEY = '3dash_reload_log';

interface ReloadRecord {
  reason: string;
  at: number;
}

/** Record the reason and reload the page after `delayMs` (default 1200). */
export function reloadWithReason(reason: string, delayMs = 1200): void {
  try {
    localStorage.setItem(RELOAD_KEY, JSON.stringify({ reason, at: Date.now() } satisfies ReloadRecord));
  } catch { /* storage full/blocked — reload anyway */ }
  setTimeout(() => window.location.reload(), delayMs);
}

/** Reason for the reload that produced this boot, when it was recent (<2 min). */
export function consumeReloadReason(): string | null {
  try {
    const raw = localStorage.getItem(RELOAD_KEY);
    if (!raw) return null;
    localStorage.removeItem(RELOAD_KEY);
    const rec = JSON.parse(raw) as ReloadRecord;
    return Date.now() - rec.at < 120_000 ? rec.reason : null;
  } catch {
    return null;
  }
}

/* ── Boot phase marks ── */

const marks: Array<{ name: string; t: number }> = [];

/** Record a boot milestone (ms measured from navigation start). */
export function markBoot(name: string): void {
  marks.push({ name, t: performance.now() });
}

/** One-line summary of the boot: total + per-phase durations. */
export function bootSummary(): string {
  const parts = marks.map((m, i) => {
    const prev = i === 0 ? 0 : marks[i - 1].t;
    return `${m.name} ${((m.t - prev) / 1000).toFixed(1)}s`;
  });
  const total = marks.length ? (marks[marks.length - 1].t / 1000).toFixed(1) : '?';
  return `boot ${total}s (${parts.join(', ')})${scriptTimings()}`;
}

/** Download stats of the largest script: distinguishes network from compile time. */
function scriptTimings(): string {
  try {
    const scripts = performance.getEntriesByType('resource')
      .filter((e): e is PerformanceResourceTiming => e instanceof PerformanceResourceTiming)
      .filter((e) => e.initiatorType === 'script' || e.name.endsWith('.js'))
      .sort((a, b) => b.duration - a.duration);
    const top = scripts[0];
    if (!top) return '';
    const file = top.name.split('/').pop()?.split('?')[0] ?? '?';
    const cached = top.transferSize === 0 ? 'cache' : `${(top.transferSize / 1024 / 1024).toFixed(1)}MB net`;
    return ` [${file}: ${(top.duration / 1000).toFixed(1)}s ${cached}]`;
  } catch {
    return '';
  }
}
