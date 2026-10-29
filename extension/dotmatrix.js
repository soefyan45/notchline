import Clutter from 'gi://Clutter';
import St from 'gi://St';

// Dot-matrix readouts of the TE theme (the design sets them in Doto). Drawn with Cairo
// on a 5x7 grid so they look the same without the font installed. The dot color is the
// actor's CSS color.

const ROWS = 7;
// Lit part of each cell; the rest is the gap between dots
const DOT_FILL = 0.8;

const GLYPHS = {
    '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
    '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
    '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
    '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
    '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
    '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
    '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
    '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
    '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
    '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
    'A': ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
    'B': ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
    'C': ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
    'D': ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
    'E': ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
    'F': ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
    'G': ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
    'H': ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
    'I': ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
    'J': ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
    'K': ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
    'L': ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
    'M': ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
    'N': ['10001', '10001', '11001', '10101', '10011', '10001', '10001'],
    'O': ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
    'P': ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
    'Q': ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
    'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
    'S': ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
    'T': ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
    'U': ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
    'V': ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
    'W': ['10001', '10001', '10001', '10101', '10101', '10101', '01010'],
    'X': ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
    'Y': ['10001', '10001', '10001', '01010', '00100', '00100', '00100'],
    'Z': ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
    // Doto's point sits low and reads as a small cross between the digits
    '.': ['000', '000', '000', '000', '010', '111', '010'],
    ':': ['0', '0', '1', '0', '1', '0', '0'],
    '/': ['00001', '00001', '00010', '00100', '01000', '10000', '10000'],
    '%': ['11000', '11001', '00010', '00100', '01000', '10011', '00011'],
    '-': ['000', '000', '000', '111', '000', '000', '000'],
    '+': ['00000', '00100', '00100', '11111', '00100', '00100', '00000'],
    '?': ['01110', '10001', '00001', '00010', '00100', '00000', '00100'],
    ' ': ['00', '00', '00', '00', '00', '00', '00'],
};

// Glyph columns of a text, one empty column between characters
function columns(text) {
    const cols = [];
    for (const char of text.toUpperCase()) {
        const glyph = GLYPHS[char] ?? GLYPHS['?'];
        if (cols.length)
            cols.push(null);
        for (let x = 0; x < glyph[0].length; x++)
            cols.push(glyph.map(row => row[x] === '1'));
    }
    return cols;
}

export class DotMatrix {
    // height: logical px of the 7 dot rows (about the cap height of the design's Doto text)
    constructor(styleClass, height, text = '') {
        this._height = height;
        this._cols = [];
        this.actor = new St.DrawingArea({style_class: styleClass, y_align: Clutter.ActorAlign.END});
        this.actor.connect('repaint', area => this._paint(area));
        this.text = text;
    }

    get text() {
        return this._text;
    }

    set text(value) {
        if (value === this._text)
            return;
        this._text = value;
        this._cols = columns(value);
        // CSS lengths are scaled by St, so the size stays in logical pixels
        const pitch = this._height / ROWS;
        this.actor.style = `width: ${this._cols.length * pitch}px; height: ${this._height}px;`;
        this.actor.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        const [, height] = area.get_surface_size();
        const pitch = height / ROWS;
        const dot = pitch * DOT_FILL;
        const color = area.get_theme_node().get_foreground_color();
        cr.setSourceRGBA(color.red / 255, color.green / 255, color.blue / 255, color.alpha / 255);
        this._cols.forEach((col, x) => col?.forEach((lit, y) => {
            if (lit)
                cr.rectangle(x * pitch, y * pitch, dot, dot);
        }));
        cr.fill();
        cr.$dispose();
    }
}

// Battery of the TE theme: a shell with a terminal and segments lit by the charge.
// Drawn in the actor's CSS color; unlit segments are a faint version of it.
const BATTERY_SEGMENTS = 5;
const BATTERY_UNLIT_ALPHA = 0.18;

export class BatteryIcon {
    constructor(styleClass) {
        this._level = 0;
        this.actor = new St.DrawingArea({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        this.actor.connect('repaint', area => this._paint(area));
    }

    set level(percentage) {
        const lit = Math.ceil(Math.min(Math.max(percentage, 0), 100) / 100 * BATTERY_SEGMENTS);
        if (lit === this._level)
            return;
        this._level = lit;
        this.actor.queue_repaint();
    }

    _paint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const color = area.get_theme_node().get_foreground_color();
        const [r, g, b] = [color.red / 255, color.green / 255, color.blue / 255];
        // Proportions of a 30x14 icon: 1.5 px shell, 3 px terminal, 1 px gaps
        const unit = height / 14;
        const line = 1.5 * unit;
        const nub = 3 * unit;
        const body = width - nub;

        cr.setSourceRGBA(r, g, b, 1);
        cr.setLineWidth(line);
        cr.rectangle(line / 2, line / 2, body - line, height - line);
        cr.stroke();
        cr.rectangle(body, height * 0.3, nub - unit, height * 0.4);
        cr.fill();

        const inset = line + unit;
        const gap = unit;
        const segment = (body - 2 * inset - gap * (BATTERY_SEGMENTS - 1)) / BATTERY_SEGMENTS;
        for (let i = 0; i < BATTERY_SEGMENTS; i++) {
            cr.setSourceRGBA(r, g, b, i < this._level ? 1 : BATTERY_UNLIT_ALPHA);
            cr.rectangle(inset + i * (segment + gap), inset, segment, height - 2 * inset);
            cr.fill();
        }
        cr.$dispose();
    }
}
