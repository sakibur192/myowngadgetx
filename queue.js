/**
 * queue.js — request SCHEDULER
 * ----------------------------
 * The phone can only drive one app at a time, so operations must not overlap.
 * This is a simple FIFO queue: every request is accepted and gets a job id,
 * then jobs run ONE AT A TIME in the order they arrived — but ALL of them run.
 *
 * enqueue(meta, fn) -> job   (returns immediately; the work runs in the background)
 * get(id) -> job            (status: queued | running | done | failed)
 * list(limit) -> jobs
 * stats() -> { running, queued, total }
 */
let seq = 0;
const jobs = new Map();          // id -> job
const waiting = [];              // job ids waiting to run
let running = false;
let onChange = () => {};
const MAX_KEPT = 300;            // keep the last N jobs for history

function strip(job) { const { _fn, ...rest } = job; return rest; }

function enqueue(meta, fn) {
  const job = {
    id: ++seq,
    label: meta.label || meta.action || 'job',
    action: meta.action || null,
    instance: meta.instance != null ? meta.instance : null,
    status: 'queued',
    queuedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
    _fn: fn,
  };
  jobs.set(job.id, job);
  waiting.push(job.id);
  // trim old finished jobs so the map doesn't grow forever
  if (jobs.size > MAX_KEPT) {
    const old = [...jobs.values()].filter((j) => j.status === 'done' || j.status === 'failed')
      .sort((a, b) => a.id - b.id);
    while (jobs.size > MAX_KEPT && old.length) jobs.delete(old.shift().id);
  }
  onChange(strip(job));
  pump();
  return strip(job);
}

async function pump() {
  if (running) return;
  running = true;
  while (waiting.length) {
    const job = jobs.get(waiting.shift());
    if (!job) continue;
    job.status = 'running';
    job.startedAt = Date.now();
    onChange(strip(job));
    try {
      job.result = await job._fn();
      job.status = 'done';
    } catch (e) {
      job.error = (e && e.message) || String(e);
      job.status = 'failed';
    }
    job.finishedAt = Date.now();
    delete job._fn;
    onChange(strip(job));
  }
  running = false;
}

function get(id) {
  const j = jobs.get(Number(id));
  return j ? strip(j) : null;
}
function list(limit = 60) {
  return [...jobs.values()].sort((a, b) => b.id - a.id).slice(0, limit).map(strip);
}
function stats() {
  return { running, queued: waiting.length, total: jobs.size };
}
function setOnChange(fn) { onChange = typeof fn === 'function' ? fn : () => {}; }

module.exports = { enqueue, get, list, stats, setOnChange };
