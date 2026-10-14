import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// Chip names that expose a real CPU temperature, best match first.
const CPU_CHIPS = ['k10temp', 'coretemp', 'zenpower', 'cpu_thermal', 'k8temp'];

// Chip names that expose a GPU temperature.
const GPU_CHIPS = ['nvidia', 'amdgpu', 'nouveau', 'radeon', 'xe', 'i915'];

/**
 * Read a small sysfs or proc file without blocking the shell.
 * Returns null when the path is missing.
 *
 * @param {string} path
 * @returns {Promise<string|null>}
 */
export function readText(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise(resolve => {
        file.load_contents_async(null, (source, result) => {
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (!ok || contents == null) {
                    resolve(null);
                    return;
                }
                const text = contents instanceof Uint8Array
                    ? new TextDecoder().decode(contents)
                    : String(contents);
                resolve(text.trim());
            } catch {
                resolve(null);
            }
        });
    });
}

/**
 * @param {string} path
 * @returns {Promise<number|null>}
 */
export async function readInt(path) {
    const text = await readText(path);
    if (text == null || text === '')
        return null;
    const value = Number.parseInt(text, 10);
    return Number.isNaN(value) ? null : value;
}

/**
 * @param {string} path
 * @returns {string[]}
 */
function listDir(path) {
    let dir;
    try {
        dir = GLib.Dir.open(path, 0);
    } catch {
        return [];
    }

    const names = [];
    try {
        let name = dir.read_name();
        while (name != null) {
            // Copy immediately. GLib.Dir reuses its internal buffer.
            names.push(String(name));
            name = dir.read_name();
        }
    } finally {
        dir.close();
    }
    return names;
}

/**
 * @param {string} chip
 * @param {string|null} label
 */
function scoreCpu(chip, label) {
    const text = (label || '').toLowerCase();
    if (chip === 'k10temp' && text === 'tctl')
        return 100;
    if (chip === 'k10temp' && text === 'tdie')
        return 90;
    if (chip === 'coretemp' && text.startsWith('package id 0'))
        return 100;
    if (chip === 'coretemp' && text.startsWith('package'))
        return 80;
    if (chip === 'coretemp' && text.startsWith('core'))
        return 50;
    if (CPU_CHIPS.includes(chip))
        return 40;
    return 0;
}

/**
 * @param {string} chip
 * @param {string|null} label
 */
function scoreGpu(chip, label) {
    if (!GPU_CHIPS.includes(chip))
        return 0;

    const text = (label || '').toLowerCase();
    // Prefer the sensor people mean by "GPU temperature".
    if (chip === 'amdgpu' && text === 'edge')
        return 100;
    if (chip === 'amdgpu' && text === 'junction')
        return 70;
    if (chip === 'amdgpu' && text === 'mem')
        return 40;
    if (chip === 'nvidia')
        return 95;

    // Discrete GPUs outrank integrated ones when both are present.
    const rank = {
        nvidia: 90,
        nouveau: 80,
        amdgpu: 70,
        radeon: 60,
        xe: 50,
        i915: 40,
    };
    return rank[chip] ?? 10;
}

function fanRank(label) {
    const text = (label || '').toLowerCase();
    if (text.includes('cpu'))
        return 0;
    if (text.includes('gpu'))
        return 1;
    return 2;
}

/**
 * @param {string|null} label
 * @param {string} fallback
 */
export function prettyLabel(label, fallback) {
    if (!label)
        return fallback;

    return label
        .replaceAll('_', ' ')
        .split(/\s+/)
        .filter(Boolean)
        .map(word => {
            const lower = word.toLowerCase();
            if (lower === 'cpu' || lower === 'gpu')
                return lower.toUpperCase();
            return lower.charAt(0).toUpperCase() + lower.slice(1);
        })
        .join(' ');
}

async function readChips() {
    const chips = [];
    const entries = listDir('/sys/class/hwmon').sort();

    for (const entry of entries) {
        const base = `/sys/class/hwmon/${entry}`;
        const name = await readText(`${base}/name`);
        if (!name)
            continue;

        const temps = [];
        const fans = [];
        for (const file of listDir(base)) {
            const temp = file.match(/^temp(\d+)_input$/);
            if (temp) {
                temps.push({
                    index: Number(temp[1]),
                    label: await readText(`${base}/temp${temp[1]}_label`),
                    path: `${base}/${file}`,
                });
                continue;
            }

            const fan = file.match(/^fan(\d+)_input$/);
            if (fan) {
                fans.push({
                    index: Number(fan[1]),
                    label: await readText(`${base}/fan${fan[1]}_label`),
                    path: `${base}/${file}`,
                });
            }
        }

        chips.push({id: entry, name, temps, fans});
    }

    return chips;
}

function pickFans(chips) {
    // asus-nb-wmi (the PX13, and most ASUS laptops) labels cpu_fan and gpu_fan.
    // The ACPI fan device on the same machine is a coarse duplicate, so skip it
    // when a better controller is present.
    let chosen = chips.filter(chip => chip.name === 'asus' && chip.fans.length);
    if (!chosen.length)
        chosen = chips.filter(chip => chip.fans.length && chip.name !== 'acpi_fan');
    if (!chosen.length)
        chosen = chips.filter(chip => chip.fans.length);

    const fans = [];
    for (const chip of chosen) {
        for (const fan of chip.fans) {
            fans.push({
                chip: chip.name,
                label: prettyLabel(fan.label, `Fan ${fan.index}`),
                path: fan.path,
                index: fan.index,
            });
        }
    }

    fans.sort((a, b) => fanRank(a.label) - fanRank(b.label) || a.index - b.index);
    return fans;
}

/**
 * Find CPU, GPU, and fan sysfs paths. Hwmon numbers change between boots,
 * so callers should rediscover instead of caching indexes.
 */
export async function discover() {
    const chips = await readChips();

    let cpu = null;
    let cpuScore = 0;
    const gpus = [];

    for (const chip of chips) {
        for (const temp of chip.temps) {
            const cpuRank = scoreCpu(chip.name, temp.label);
            if (cpuRank > cpuScore) {
                cpuScore = cpuRank;
                cpu = {
                    chip: chip.name,
                    label: prettyLabel(temp.label, 'CPU'),
                    path: temp.path,
                };
            }

            const gpuRank = scoreGpu(chip.name, temp.label);
            if (gpuRank > 0) {
                gpus.push({
                    chip: chip.name,
                    label: prettyLabel(temp.label, 'GPU'),
                    path: temp.path,
                    score: gpuRank,
                });
            }
        }
    }

    // One temperature per device. amdgpu exposes edge, junction, and memory;
    // the edge sensor is the GPU temperature.
    const gpuByDevice = new Map();
    for (const gpu of gpus) {
        const device = gpu.path.replace(/\/temp\d+_input$/, '');
        const previous = gpuByDevice.get(device);
        if (!previous || gpu.score > previous.score)
            gpuByDevice.set(device, gpu);
    }
    gpus.length = 0;
    gpus.push(...[...gpuByDevice.values()].sort((a, b) => b.score - a.score));

    if (!cpu) {
        let best = null;
        for (const chip of chips) {
            if (chip.name !== 'acpitz')
                continue;
            for (const temp of chip.temps) {
                const value = await readInt(temp.path);
                if (value == null)
                    continue;
                const celsius = value / 1000;
                if (celsius < 15 || celsius > 115)
                    continue;
                if (!best || value > best.millidegree)
                    best = {
                        chip: chip.name,
                        label: prettyLabel(temp.label, 'ACPI'),
                        path: temp.path,
                        millidegree: value,
                    };
            }
        }
        if (best)
            cpu = {chip: best.chip, label: best.label, path: best.path};
    }

    return {
        cpu,
        gpus,
        fans: pickFans(chips),
    };
}

/**
 * Memory in use, based on MemAvailable. This matches GNOME System Monitor
 * more closely than MemFree, which ignores caches the kernel can reclaim.
 *
 * @returns {{percent: number, usedKb: number, totalKb: number}|null}
 */
export async function readMemory() {
    const text = await readText('/proc/meminfo');
    if (!text)
        return null;

    const read = key => {
        const match = text.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
        return match ? Number(match[1]) : null;
    };

    const total = read('MemTotal');
    const available = read('MemAvailable');
    if (total == null || available == null || total <= 0)
        return null;

    const used = Math.max(0, total - available);
    return {
        percent: used / total * 100,
        usedKb: used,
        totalKb: total,
    };
}

/**
 * @param {ReturnType<discover>} sensors
 */
export async function readSnapshot(sensors) {
    const readTemp = async sensor => {
        if (!sensor)
            return null;
        const value = await readInt(sensor.path);
        if (value == null)
            return {sensor, millidegree: null, failed: true};
        return {sensor, millidegree: value, failed: false};
    };

    const [cpu, gpus, fans, memory] = await Promise.all([
        readTemp(sensors.cpu),
        Promise.all(sensors.gpus.map(sensor => readTemp(sensor))),
        Promise.all(sensors.fans.map(async sensor => {
            const rpm = await readInt(sensor.path);
            return {sensor, rpm, failed: rpm == null};
        })),
        readMemory(),
    ]);

    return {
        cpu,
        gpus,
        fans,
        memory,
        failed: Boolean(cpu?.failed) || gpus.some(gpu => gpu?.failed) || fans.some(fan => fan.failed),
    };
}
