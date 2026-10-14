/** Five minutes, in the same microseconds as GLib.get_monotonic_time(). */
export const HISTORY_WINDOW_US = 5 * 60 * 1000000;

/**
 * Drop samples that have scrolled out of the five-minute window.
 *
 * @param {{t: number}[]} samples
 * @param {number} now
 */
export function trimHistory(samples, now) {
    const start = now - HISTORY_WINDOW_US;
    let index = 0;
    while (index < samples.length && samples[index].t < start)
        index += 1;
    if (index > 0)
        samples.splice(0, index);
}

/**
 * Points for the last five minutes. A point's value is final the moment
 * it is drawn: one sample when the plot has room, otherwise the average
 * of a time slot that has already ended. The slot still in progress is
 * left out, so a later reading cannot change a point already shown.
 *
 * @param {{t: number}[]} samples
 * @param {number} now
 * @param {(sample: object) => number|null} pick
 * @param {number} capacity how many points fit across the plot
 * @returns {{x: number, value: number|null}[]}
 *   x is 0 five minutes ago and 1 at now.
 */
export function chartPoints(samples, now, pick, capacity) {
    const windowStart = now - HISTORY_WINDOW_US;
    const present = samples.filter(sample => sample.t >= windowStart && sample.t <= now);
    const columns = columnCount(capacity);

    if (present.length <= columns) {
        return present.map(sample => ({
            x: (sample.t - windowStart) / HISTORY_WINDOW_US,
            value: readValue(sample, pick),
        }));
    }

    const slotUs = Math.ceil(HISTORY_WINDOW_US / columns);
    const firstIndex = Math.ceil(windowStart / slotUs);
    const lastIndex = Math.floor(now / slotUs) - 1;
    const sums = new Map();
    const counts = new Map();

    for (const sample of present) {
        const index = Math.floor(sample.t / slotUs);
        if (index < firstIndex || index > lastIndex)
            continue;
        const value = readValue(sample, pick);
        if (value == null)
            continue;
        sums.set(index, (sums.get(index) ?? 0) + value);
        counts.set(index, (counts.get(index) ?? 0) + 1);
    }

    const points = [];
    for (let index = firstIndex; index <= lastIndex; index++) {
        const start = index * slotUs;
        const end = start + slotUs;
        if (start < windowStart || end > now)
            continue;
        points.push({
            x: ((start + end) / 2 - windowStart) / HISTORY_WINDOW_US,
            value: counts.has(index) ? sums.get(index) / counts.get(index) : null,
        });
    }
    return points;
}

function columnCount(capacity) {
    return Math.max(2, Math.floor(capacity) || 0);
}

function readValue(sample, pick) {
    const value = pick(sample);
    return value == null || Number.isNaN(value) ? null : value;
}
