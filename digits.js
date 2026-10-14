/**
 * Fixed-width fan speeds. Leading zeros stay in the string and are marked
 * so the panel can draw them dimmer than the significant digits.
 *
 * @param {Array<number|null>} values
 * @param {{pad: boolean, digits: number}} options
 */
export function readingMarkup(values, {pad, digits}) {
    if (!values.length)
        return '—';

    const rendered = values.map(value => {
        if (value == null || Number.isNaN(value))
            return null;
        return String(Math.max(0, Math.round(value)));
    });

    const width = pad
        ? Math.max(digits, ...rendered.map(value => value?.length ?? 0))
        : 0;

    return rendered
        .map(value => value == null ? '—' : (pad ? paddedMarkup(value, width) : escapeMarkup(value)))
        .join('<span fgalpha="45%"> · </span>');
}

function paddedMarkup(raw, width) {
    const text = raw.padStart(width, '0');
    let cut = text.search(/[1-9]/);
    if (cut < 0)
        cut = Math.max(0, text.length - 1);
    const dim = text.slice(0, cut);
    const rest = text.slice(cut);
    if (!dim)
        return escapeMarkup(rest);
    return `<span fgalpha="38%">${escapeMarkup(dim)}</span>${escapeMarkup(rest)}`;
}

function escapeMarkup(text) {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}
