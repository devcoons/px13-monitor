import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {readingMarkup} from './digits.js';
import {chartPoints, trimHistory} from './history.js';
import {discover, readSnapshot} from './sensors.js';

const REDISCOVER_SECONDS = 20;

export default class HardwareMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._sensors = null;
        this._discoveredAt = 0;
        this._timeout = 0;
        this._settingsId = this._settings.connect('changed', () => this._onSettingsChanged());
        this._history = [];
        this._epoch = (this._epoch ?? 0) + 1;
        this._reading = false;

        this._indicator = new PanelMenu.Button(0.5, 'Hardware monitor', false);
        this._buildHistory();

        this._root = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._normalBar = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'px13-bar',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._compactBar = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'px13-bar',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._root.add_child(this._normalBar);
        this._root.add_child(this._compactBar);

        this._cpu = this._addMetric(this._normalBar, 'CPU');
        this._gpu = this._addMetric(this._normalBar, 'GPU');
        this._fan = this._addMetric(this._normalBar, 'FAN');
        this._ram = this._addMetric(this._normalBar, 'RAM');

        this._compactCpu = this._addInline(this._compactBar, 'CPU');
        this._compactGpu = this._addInline(this._compactBar, 'GPU');
        this._compactOther = this._addInline(this._compactBar, 'FAN');
        this._compactRam = this._addInline(this._compactBar, 'RAM');
        this._compactRam.rpm.visible = false;

        this._indicator.add_child(this._root);
        Main.panel.addToStatusArea(this.uuid, this._indicator, 1, 'right');

        this._applyLayout();
        this._refresh();
        this._armTimer();
    }

    disable() {
        this._disarmTimer();
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._settings = null;
        this._epoch = (this._epoch ?? 0) + 1;
        this._reading = false;
        this._normalBar?.destroy();
        this._normalBar = null;
        this._compactBar?.destroy();
        this._compactBar = null;
        this._root?.destroy();
        this._root = null;
        this._indicator?.destroy();
        this._indicator = null;
        this._sensors = null;
        this._history = [];
        this._charts = null;
    }

    _addMetric(parent, tag) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'px13-inline',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const tagLabel = new St.Label({
            text: tag,
            style_class: 'px13-tag',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({
            text: '—',
            style_class: 'px13-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(tagLabel);
        box.add_child(value);
        parent.add_child(box);
        return {box, value};
    }

    _addInline(parent, tag) {
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'px13-inline',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const tagLabel = new St.Label({
            text: tag,
            style_class: 'px13-tag',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const value = new St.Label({
            text: '—',
            style_class: 'px13-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const rpm = new St.Label({
            text: '',
            style_class: 'px13-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        box.add_child(tagLabel);
        box.add_child(value);
        box.add_child(rpm);
        parent.add_child(box);
        return {box, value, rpm};
    }

    _onSettingsChanged() {
        this._applyLayout();
        this._armTimer();
        this._refresh();
    }

    _applyLayout() {
        const compact = this._settings.get_boolean('compact');
        this._normalBar.visible = !compact;
        this._compactBar.visible = compact;
        this._cpu.box.visible = this._settings.get_boolean('show-cpu');
        this._gpu.box.visible = this._settings.get_boolean('show-gpu');
        this._fan.box.visible = this._settings.get_boolean('show-fan');
        this._ram.box.visible = this._settings.get_boolean('show-ram');
    }

    _armTimer() {
        this._disarmTimer();
        const seconds = this._settings.get_int('refresh-interval');
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._refresh();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _disarmTimer() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
    }

    _refresh() {
        this._readSensors().catch(error => logError(error));
        return GLib.SOURCE_CONTINUE;
    }

    async _readSensors() {
        if (this._reading || !this._settings)
            return;
        this._reading = true;
        const epoch = this._epoch;
        try {
            const now = GLib.get_monotonic_time();
            if (!this._sensors || now - this._discoveredAt > REDISCOVER_SECONDS * 1e6) {
                const sensors = await discover();
                if (epoch !== this._epoch)
                    return;
                this._sensors = sensors;
                this._discoveredAt = now;
            }

            const snapshot = await readSnapshot(this._sensors);
            if (epoch !== this._epoch)
                return;
            if (snapshot.failed) {
                this._sensors = null;
                this._discoveredAt = 0;
            }
            this._render(snapshot);
        } catch (error) {
            if (epoch === this._epoch)
                logError(error);
        } finally {
            if (epoch === this._epoch)
                this._reading = false;
        }
    }

    _render(snapshot) {
        const unit = this._settings.get_string('unit');
        const tempHigh = this._settings.get_int('temp-high');
        const tempWarn = this._settings.get_int('temp-warn');
        const tempCrit = this._settings.get_int('temp-crit');
        const ramHigh = this._settings.get_int('ram-high');
        const ramWarn = this._settings.get_int('ram-warn');
        const ramCrit = this._settings.get_int('ram-crit');
        const fanOptions = {
            pad: this._settings.get_boolean('fan-pad'),
            digits: this._settings.get_int('fan-digits'),
        };
        const showCpu = this._settings.get_boolean('show-cpu');
        const showGpu = this._settings.get_boolean('show-gpu');
        const showFan = this._settings.get_boolean('show-fan');
        const showRam = this._settings.get_boolean('show-ram');

        const cpuC = celsiusOf(snapshot.cpu?.millidegree);
        const gpu = snapshot.gpus[0] ?? null;
        const gpuC = celsiusOf(gpu?.millidegree);
        const memory = snapshot.memory;
        const ramPercent = memory ? memory.percent : null;
        const cpuFans = fanRpms(snapshot.fans, 'cpu');
        const gpuFans = fanRpms(snapshot.fans, 'gpu');
        const otherFans = fanRpms(snapshot.fans, 'other');

        this._showReading(this._cpu, {
            text: formatTemp(snapshot.cpu?.millidegree, unit),
            tone: toneFor(cpuC, tempHigh, tempWarn, tempCrit),
        });
        this._showReading(this._gpu, {
            text: formatTemp(gpu?.millidegree, unit),
            tone: toneFor(gpuC, tempHigh, tempWarn, tempCrit),
        });

        const allRpms = snapshot.fans.map(fan => fan.rpm);
        setMarkup(this._fan.value, readingMarkup(allRpms.length ? allRpms : [null], fanOptions));
        setTone(this._fan.value, 'normal');

        this._showReading(this._ram, {
            text: ramPercent == null ? '—' : `${Math.round(ramPercent)}%`,
            tone: toneFor(ramPercent, ramHigh, ramWarn, ramCrit),
        });

        this._showInline(this._compactCpu, {
            showValue: showCpu,
            value: formatTemp(snapshot.cpu?.millidegree, unit),
            tone: toneFor(cpuC, tempHigh, tempWarn, tempCrit),
            showRpm: showFan && cpuFans.length > 0,
            rpm: readingMarkup(cpuFans, fanOptions),
        });
        this._showInline(this._compactGpu, {
            showValue: showGpu,
            value: formatTemp(gpu?.millidegree, unit),
            tone: toneFor(gpuC, tempHigh, tempWarn, tempCrit),
            showRpm: showFan && gpuFans.length > 0,
            rpm: readingMarkup(gpuFans, fanOptions),
        });
        this._compactOther.box.visible = showFan && otherFans.length > 0;
        this._compactOther.value.visible = false;
        this._compactOther.rpm.visible = true;
        setMarkup(this._compactOther.rpm, readingMarkup(otherFans, fanOptions));
        this._showInline(this._compactRam, {
            showValue: showRam,
            value: ramPercent == null ? '—' : `${Math.round(ramPercent)}%`,
            tone: toneFor(ramPercent, ramHigh, ramWarn, ramCrit),
            showRpm: false,
            rpm: '',
        });

        this._indicator.accessible_name = this._accessibleName(snapshot, unit, showCpu, showGpu, showFan, showRam);
        this._remember({
            cpu: cpuC,
            cpuFan: peak(cpuFans),
            gpu: gpuC,
            gpuFan: peak(gpuFans),
            ram: ramPercent,
        });
    }

    _buildHistory() {
        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
            style_class: 'px13-history-item',
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'px13-history',
            x_expand: true,
        });
        this._charts = {
            cpu: this._addChart(box, 'CPU', 'cpu', 'cpuFan'),
            gpu: this._addChart(box, 'GPU', 'gpu', 'gpuFan'),
            ram: this._addChart(box, 'RAM', 'ram', null),
        };
        item.add_child(box);
        this._indicator.menu.addMenuItem(item);
    }

    _addChart(parent, title, barKey, lineKey) {
        const section = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'px13-chart-section',
            x_expand: true,
        });
        const header = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'px13-chart-header',
            x_expand: true,
        });
        const label = new St.Label({
            text: title,
            style_class: 'px13-chart-title',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const detail = new St.Label({
            text: '',
            style_class: 'px13-chart-detail',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(label);
        header.add_child(detail);

        const area = new St.DrawingArea({
            style_class: 'px13-chart',
            x_expand: true,
        });
        area.connect('repaint', () => this._paintChart(area, barKey, lineKey));
        section.add_child(header);
        section.add_child(area);
        parent.add_child(section);
        return {area, detail};
    }

    _remember(sample) {
        const t = GLib.get_monotonic_time();
        this._history.push({t, ...sample});
        trimHistory(this._history, t);
        if (this._indicator?.menu.isOpen)
            this._redrawCharts();
    }

    _redrawCharts() {
        const latest = this._history.at(-1);
        if (latest && this._charts) {
            this._charts.cpu.detail.text = latest.cpu == null
                ? '—'
                : `${Math.round(latest.cpu)}°   ${formatRpm(latest.cpuFan)}`;
            this._charts.gpu.detail.text = latest.gpu == null
                ? '—'
                : `${Math.round(latest.gpu)}°   ${formatRpm(latest.gpuFan)}`;
            this._charts.ram.detail.text = latest.ram == null
                ? '—'
                : `${Math.round(latest.ram)}%`;
        }
        for (const chart of Object.values(this._charts ?? {}))
            chart.area.queue_repaint();
    }

    _paintChart(area, barKey, lineKey) {
        const cr = area.get_context();
        try {
            const [width, height] = area.get_surface_size();
            if (width < 10 || height < 10)
                return;
            const now = GLib.get_monotonic_time();
            const theme = foregroundRgb(area);
            const capacity = pointCapacity(width, height);
            const bars = chartPoints(this._history, now, sample => sample[barKey], capacity);
            if (lineKey) {
                const digits = this._settings.get_int('fan-digits');
                paintCombo(cr, width, height, theme, {
                    bars,
                    line: chartPoints(this._history, now, sample => sample[lineKey], capacity),
                    fanMax: 10 ** digits,
                    capacity,
                });
            } else {
                paintLine(cr, width, height, theme, bars);
            }
        } finally {
            cr.$dispose();
        }
    }

    _showReading(metric, {text, tone}) {
        metric.value.text = text;
        setTone(metric.value, tone);
    }

    _showInline(group, {showValue, value, tone, showRpm, rpm}) {
        group.value.visible = showValue;
        group.value.text = value;
        setTone(group.value, tone);
        group.rpm.visible = showRpm;
        if (showRpm)
            setMarkup(group.rpm, rpm);
        group.box.visible = showValue || showRpm;
    }

    _accessibleName(snapshot, unit, showCpu, showGpu, showFan, showRam) {
        const parts = [];
        const compact = this._settings.get_boolean('compact');
        const cpuFans = fanRpms(snapshot.fans, 'cpu');
        const gpuFans = fanRpms(snapshot.fans, 'gpu');

        if (showCpu)
            parts.push(`CPU ${formatTemp(snapshot.cpu?.millidegree, unit)}`);
        if (compact && showFan)
            for (const rpm of cpuFans)
                parts.push(`CPU fan ${rpm ?? 'unavailable'} rpm`);
        if (showGpu) {
            const gpuReading = snapshot.gpus[0];
            parts.push(`GPU ${formatTemp(gpuReading?.millidegree, unit)}`);
        }
        if (compact && showFan)
            for (const rpm of gpuFans)
                parts.push(`GPU fan ${rpm ?? 'unavailable'} rpm`);
        if (showFan && !compact) {
            if (!snapshot.fans.length)
                parts.push('fans unavailable');
            else
                for (const fan of snapshot.fans)
                    parts.push(`${fan.sensor.label} ${fan.rpm ?? 'unavailable'} rpm`);
        }
        if (showRam) {
            const percent = snapshot.memory ? Math.round(snapshot.memory.percent) : null;
            parts.push(`memory ${percent == null ? 'unavailable' : `${percent} percent`}`);
        }
        return parts.join(', ') || 'Hardware monitor';
    }
}

function fanRpms(fans, role) {
    return fans.filter(fan => fanRole(fan) === role).map(fan => fan.rpm);
}

function fanRole(fan) {
    const label = (fan.sensor?.label || '').toLowerCase();
    if (label.includes('gpu'))
        return 'gpu';
    if (label.includes('cpu'))
        return 'cpu';
    return 'other';
}

function setMarkup(label, markup) {
    label.clutter_text.set_markup(markup);
}

function celsiusOf(millidegree) {
    return millidegree == null ? null : millidegree / 1000;
}

function formatTemp(millidegree, unit) {
    if (millidegree == null)
        return '—';
    const celsius = millidegree / 1000;
    const value = unit === 'fahrenheit' ? celsius * 9 / 5 + 32 : celsius;
    return unit === 'fahrenheit' ? `${Math.round(value)}°F` : `${Math.round(value)}°`;
}

function toneFor(value, high, warn, crit) {
    if (value == null)
        return 'normal';
    if (value >= crit)
        return 'crit';
    if (value >= warn)
        return 'warn';
    if (value >= high)
        return 'high';
    return 'normal';
}

function setTone(actor, tone) {
    for (const name of ['px13-high', 'px13-warn', 'px13-crit'])
        actor.remove_style_class_name(name);
    if (tone === 'high' || tone === 'warn' || tone === 'crit')
        actor.add_style_class_name(`px13-${tone}`);
}

function peak(values) {
    const present = values.filter(value => value != null);
    return present.length ? Math.max(...present) : null;
}

function formatRpm(rpm) {
    return rpm == null ? '—' : `${Math.round(rpm)} rpm`;
}

function foregroundRgb(actor) {
    try {
        const color = actor.get_theme_node().get_foreground_color();
        return [color.red / 255, color.green / 255, color.blue / 255];
    } catch {
        return [1, 1, 1];
    }
}

function paintCombo(cr, width, height, theme, {bars, line, fanMax, capacity}) {
    const layout = plotLayout(width, height);
    const [red, green, blue] = theme;
    paintFrame(cr, layout, red, green, blue);

    const temps = bars.map(point => point.value).filter(value => value != null);
    const tempMax = Math.max(100, ...temps);
    const barWidth = Math.max(1, layout.plotW / Math.max(2, capacity) * 0.72);

    cr.setSourceRGBA(red, green, blue, 0.28);
    for (const point of bars) {
        if (point.value == null)
            continue;
        const barHeight = layout.plotH * Math.min(1, point.value / tempMax);
        const x = layout.left + point.x * layout.plotW - barWidth / 2;
        const y = layout.top + layout.plotH - barHeight;
        cr.rectangle(x, y, barWidth, barHeight);
    }
    cr.fill();

    strokeSeries(cr, layout, line, fanMax, 1, 0.55, 0);
    paintAxis(cr, layout, theme, `${Math.round(tempMax)}°`, String(Math.round(fanMax)));
}

function paintLine(cr, width, height, theme, values) {
    const layout = plotLayout(width, height);
    const [red, green, blue] = theme;
    paintFrame(cr, layout, red, green, blue);
    cr.setSourceRGBA(0.21, 0.52, 0.89, 0.18);
    fillSeries(cr, layout, values, 100);
    strokeSeries(cr, layout, values, 100, 0.21, 0.52, 0.89);
    paintAxis(cr, layout, theme, '100%', '');
}

function fillSeries(cr, layout, points, maxValue) {
    const base = layout.top + layout.plotH;
    let drawing = false;
    let lastX = 0;
    for (const point of points) {
        if (point.value == null) {
            if (drawing) {
                cr.lineTo(lastX, base);
                cr.closePath();
                cr.fill();
                drawing = false;
            }
            continue;
        }
        const x = layout.left + point.x * layout.plotW;
        const y = layout.top + layout.plotH * (1 - Math.min(1, point.value / maxValue));
        if (!drawing) {
            cr.moveTo(x, base);
            cr.lineTo(x, y);
            drawing = true;
        } else {
            cr.lineTo(x, y);
        }
        lastX = x;
    }
    if (drawing) {
        cr.lineTo(lastX, base);
        cr.closePath();
        cr.fill();
    }
}

function plotLayout(width, height) {
    const scale = Math.max(1, height / 96);
    const left = 32 * scale;
    const right = 36 * scale;
    const top = 8 * scale;
    const bottom = 18 * scale;
    return {
        scale,
        left,
        right,
        top,
        plotW: Math.max(1, width - left - right),
        plotH: Math.max(1, height - top - bottom),
    };
}

function paintFrame(cr, layout, red, green, blue) {
    cr.setSourceRGBA(red, green, blue, 0.12);
    cr.setLineWidth(Math.max(1, layout.scale));
    for (const fraction of [0.5, 1]) {
        const y = layout.top + layout.plotH * (1 - fraction);
        cr.moveTo(layout.left, y);
        cr.lineTo(layout.left + layout.plotW, y);
        cr.stroke();
    }
    const base = layout.top + layout.plotH;
    cr.moveTo(layout.left, base);
    cr.lineTo(layout.left + layout.plotW, base);
    cr.stroke();
}

function pointCapacity(width, height) {
    const layout = plotLayout(width, height);
    return Math.max(2, Math.floor(layout.plotW / (4 * layout.scale)));
}

function strokeSeries(cr, layout, points, maxValue, red, green, blue) {
    cr.setSourceRGBA(red, green, blue, 1);
    cr.setLineWidth(Math.max(1.5, 1.75 * layout.scale));
    let started = false;
    for (const point of points) {
        if (point.value == null) {
            if (started)
                cr.stroke();
            started = false;
            continue;
        }
        const x = layout.left + point.x * layout.plotW;
        const y = layout.top + layout.plotH * (1 - Math.min(1, point.value / maxValue));
        if (!started) {
            cr.moveTo(x, y);
            started = true;
        } else {
            cr.lineTo(x, y);
        }
    }
    if (started)
        cr.stroke();
}

function paintAxis(cr, layout, theme, leftLabel, rightLabel) {
    const [red, green, blue] = theme;
    cr.setSourceRGBA(red, green, blue, 0.62);
    cr.setFontSize(10 * layout.scale);
    cr.moveTo(2, layout.top + 10 * layout.scale);
    cr.showText(leftLabel);
    cr.moveTo(2, layout.top + layout.plotH);
    cr.showText('0');
    if (rightLabel) {
        cr.moveTo(layout.left + layout.plotW + 4 * layout.scale, layout.top + 10 * layout.scale);
        cr.showText(rightLabel);
    }
    cr.moveTo(layout.left, layout.top + layout.plotH + 13 * layout.scale);
    cr.showText('5 min');
    cr.moveTo(layout.left + layout.plotW - 22 * layout.scale, layout.top + layout.plotH + 13 * layout.scale);
    cr.showText('now');
}
