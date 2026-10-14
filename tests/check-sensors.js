import GLib from 'gi://GLib';

import {discover, readSnapshot} from '../sensors.js';

const loop = GLib.MainLoop.new(null, false);
let failure = null;

async function check() {
    const sensors = await discover();
    const snapshot = await readSnapshot(sensors);

    const summary = {
        cpu: sensors.cpu,
        gpus: sensors.gpus.map(gpu => ({chip: gpu.chip, label: gpu.label, path: gpu.path})),
        fans: sensors.fans,
        cpuMilli: snapshot.cpu?.millidegree ?? null,
        gpuMilli: snapshot.gpus.map(gpu => gpu.millidegree),
        fanRpm: snapshot.fans.map(fan => fan.rpm),
        memory: snapshot.memory,
    };

    console.log(JSON.stringify(summary, null, 2));

    if (!sensors.cpu || sensors.cpu.chip !== 'k10temp')
        throw new Error(`expected k10temp CPU sensor, got ${sensors.cpu?.chip}`);
    if (!sensors.gpus.length || sensors.gpus[0].chip !== 'amdgpu')
        throw new Error(`expected amdgpu GPU sensor, got ${sensors.gpus[0]?.chip}`);
    if (sensors.fans.length !== 2 || sensors.fans.some(fan => fan.chip !== 'asus'))
        throw new Error(`expected ASUS cpu and gpu fans, got ${JSON.stringify(sensors.fans)}`);
    if (sensors.fans[0].label !== 'CPU Fan' || sensors.fans[1].label !== 'GPU Fan')
        throw new Error(`unexpected fan labels: ${sensors.fans.map(fan => fan.label).join(', ')}`);
    if (snapshot.cpu?.millidegree == null || snapshot.gpus[0]?.millidegree == null)
        throw new Error('temperature read failed');
    if (!snapshot.memory || snapshot.memory.percent < 0 || snapshot.memory.percent > 100)
        throw new Error('memory read failed');

    console.log('sensors ok');
}

check().then(() => loop.quit(), error => {
    failure = error;
    loop.quit();
});
loop.run();
if (failure)
    throw failure;
