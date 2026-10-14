import {HISTORY_WINDOW_US, chartPoints, trimHistory} from '../history.js';

const now = 10_000_000_000;
const samples = [
    {t: now - HISTORY_WINDOW_US - 1, cpu: 99},
    {t: now - HISTORY_WINDOW_US + 30_000_000, cpu: 40},
    {t: now - 1000, cpu: 70},
];

trimHistory(samples, now);
if (samples.length !== 2 || samples[0].cpu !== 40)
    throw new Error(`trim kept ${JSON.stringify(samples)}`);

const dedicated = chartPoints(samples, now, sample => sample.cpu, 10);
if (dedicated.length !== 2)
    throw new Error(`dedicated count ${dedicated.length}`);
if (dedicated[0].value !== 40 || dedicated[1].value !== 70)
    throw new Error(`dedicated values ${JSON.stringify(dedicated)}`);

const later = chartPoints(samples, now + 5_000_000, sample => sample.cpu, 10);
if (later[0].value !== 40 || later[1].value !== 70)
    throw new Error('a dedicated point changed its value');
if (!(later[0].x < dedicated[0].x))
    throw new Error('points should scroll left as time passes');

const capacity = 6;
const slotUs = Math.ceil(HISTORY_WINDOW_US / capacity);
const origin = slotUs * 80;
const grouped = [
    {t: origin + 10, cpu: 10},
    {t: origin + 20, cpu: 30},
    {t: origin + slotUs + 10, cpu: 80},
];
// Enough older readings, still inside the window, that the plot must average.
for (let index = 1; index <= capacity; index++)
    grouped.push({t: origin - index * slotUs + 10, cpu: 1});

const whileOpen = origin + slotUs + Math.floor(slotUs / 2);
const closed = chartPoints(grouped, whileOpen, sample => sample.cpu, capacity);
const averaged = closed.filter(point => point.value === 20);
if (averaged.length !== 1)
    throw new Error(`closed slot ${JSON.stringify(closed)}`);
if (closed.some(point => point.value === 80))
    throw new Error('the open slot was drawn');

const stillOpen = chartPoints(grouped, whileOpen + 1000, sample => sample.cpu, capacity);
if (stillOpen.filter(point => point.value === 20).length !== 1)
    throw new Error('a closed slot changed before the next one finished');
if (stillOpen.some(point => point.value === 80))
    throw new Error('the open slot appeared early');

const afterClose = origin + slotUs * 2;
const both = chartPoints(grouped, afterClose, sample => sample.cpu, capacity);
if (both.filter(point => point.value === 20).length !== 1 ||
    both.filter(point => point.value === 80).length !== 1)
    throw new Error(`finished slots ${JSON.stringify(both)}`);

console.log('history ok');
