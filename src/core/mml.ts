/**
 * Music Macro Language (MML), the text notation chiptune composers have typed since the 1980s, read into notes on a
 * row grid.
 *
 * | Command        | Meaning                                                                  |
 * |----------------|--------------------------------------------------------------------------|
 * | `c d e f g a b`| a note; `+` or `#` sharp, `-` flat; then an optional length and dots      |
 * | `r`            | a rest, with an optional length                                          |
 * | `n60`          | a note by MIDI number (60 is middle C), with an optional `,length`        |
 * | `o4` `<` `>`   | set the octave, one octave down, one octave up                           |
 * | `l8`           | default length: 1 whole, 2 half, 4 quarter, 8 eighth, 16, 32; 3, 6, 12 triplets |
 * | `v12`          | volume 0-15 for the next notes                                           |
 * | `@2`           | tone 0-3 for the next notes (pulse duty, arp chord...)                   |
 * | `@d3`          | decay 0-3 for the next notes (none, slow, medium, fast)                  |
 * | `&`            | tie: the next note continues this one without a new attack               |
 * | `[ ... ]3`     | repeat the bracketed part 3 times (2 if no count)                        |
 * | `\|` and spaces| ignored, for readability; `;` starts a comment to the end of the line    |
 */

export interface NoteEvent {
  /** First row of the note. */
  row: number;
  /** Length in rows. */
  rows: number;
  /** MIDI note number. */
  midi: number;
  /** Volume 0-15. */
  vol: number;
  /** Tone 0-3, or -1 for the channel's own. */
  tone: number;
  /** Decay 0-3, or -1 for the channel's own. */
  decay: number;
}

export interface ParsedPart {
  notes: NoteEvent[];
  /** Total length in rows, rests included. */
  rows: number;
}

export class MmlError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(`${message} (at character ${position + 1})`);
    this.name = "MmlError";
  }
}

const LETTER: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** Expand `[ ... ]n` repeats, keeping each character's source position for error messages. */
function expand(src: string): Array<[string, number]> {
  const chars: Array<[string, number]> = [];
  let inComment = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === ";") inComment = true;
    if (ch === "\n") inComment = false;
    if (inComment || /\s|\|/.test(ch)) continue;
    chars.push([ch.toLowerCase(), i]);
  }
  const parse = (start: number, depth: number): [Array<[string, number]>, number] => {
    const out: Array<[string, number]> = [];
    let i = start;
    while (i < chars.length) {
      const [ch, pos] = chars[i]!;
      if (ch === "[") {
        if (depth > 8) throw new MmlError("repeats nested too deep", pos);
        const [inner, end] = parse(i + 1, depth + 1);
        if (end >= chars.length || chars[end]![0] !== "]") throw new MmlError("unclosed [", pos);
        let j = end + 1;
        let digits = "";
        while (j < chars.length && /[0-9]/.test(chars[j]![0])) digits += chars[j++]![0];
        const count = digits ? parseInt(digits, 10) : 2;
        if (count < 1 || count > 64) throw new MmlError("repeat count must be 1 to 64", pos);
        for (let k = 0; k < count; k++) out.push(...inner);
        i = j;
      } else if (ch === "]") {
        if (depth === 0) throw new MmlError("] without [", pos);
        return [out, i];
      } else {
        out.push(chars[i]!);
        i++;
      }
    }
    return [out, i];
  };
  return parse(0, 0)[0];
}

/**
 * Read one part. `rowsPerQuarter` sets the grid: 4 gives sixteenth-note rows, 6 also allows eighth-note triplets.
 */
export function parseMml(src: string, rowsPerQuarter: number): ParsedPart {
  const s = expand(src);
  let i = 0;
  let octave = 4;
  let defaultRows = rowsPerQuarter; // l4
  let vol = 12;
  let tone = -1;
  let decay = -1;
  let row = 0;
  const notes: NoteEvent[] = [];
  let tie = false;

  const peek = (): string => (i < s.length ? s[i]![0] : "");
  const pos = (): number => (i < s.length ? s[i]![1] : (s[s.length - 1]?.[1] ?? 0));
  const number = (): number | null => {
    let d = "";
    while (/[0-9]/.test(peek())) d += s[i++]![0];
    return d ? parseInt(d, 10) : null;
  };
  const lengthRows = (at: number): number => {
    const len = number();
    let rows = len === null ? defaultRows : rowsOf(len, at);
    let add = rows;
    while (peek() === ".") {
      i++;
      add /= 2;
      rows += add;
    }
    if (!Number.isInteger(rows) || rows <= 0) throw new MmlError("this length does not fit the row grid", at);
    return rows;
  };
  const rowsOf = (len: number, at: number): number => {
    if (len < 1 || len > 64) throw new MmlError("note length must be 1 to 64", at);
    const rows = (rowsPerQuarter * 4) / len;
    if (!Number.isInteger(rows)) throw new MmlError(`length ${len} does not fit a grid of ${rowsPerQuarter} rows per beat`, at);
    return rows;
  };
  const addNote = (midi: number, rows: number, at: number): void => {
    if (midi < 12 || midi > 120) throw new MmlError("note out of range", at);
    const last = notes[notes.length - 1];
    if (tie && last && last.row + last.rows === row && last.midi === midi) {
      last.rows += rows;
    } else {
      notes.push({ row, rows, midi, vol, tone, decay });
    }
    row += rows;
  };

  while (i < s.length) {
    const at = pos();
    const ch = s[i++]![0];
    if (ch in LETTER) {
      let semis = LETTER[ch]!;
      while (peek() === "+" || peek() === "#" || peek() === "-") semis += s[i++]![0] === "-" ? -1 : 1;
      const rows = lengthRows(at);
      addNote(12 * (octave + 1) + semis, rows, at);
      tie = false;
      if (peek() === "&") {
        i++;
        tie = true;
      }
    } else if (ch === "r") {
      row += lengthRows(at);
      tie = false;
    } else if (ch === "n") {
      const m = number();
      if (m === null) throw new MmlError("n needs a MIDI note number", at);
      let rows = defaultRows;
      if (peek() === ",") {
        i++;
        rows = lengthRows(at);
      }
      addNote(m, rows, at);
      tie = false;
      if (peek() === "&") {
        i++;
        tie = true;
      }
    } else if (ch === "o") {
      const o = number();
      if (o === null || o < 0 || o > 8) throw new MmlError("octave must be 0 to 8", at);
      octave = o;
    } else if (ch === "<") {
      octave = Math.max(0, octave - 1);
    } else if (ch === ">") {
      octave = Math.min(8, octave + 1);
    } else if (ch === "l") {
      const len = number();
      if (len === null) throw new MmlError("l needs a length", at);
      let rows = rowsOf(len, at);
      let add = rows;
      while (peek() === ".") {
        i++;
        add /= 2;
        rows += add;
      }
      if (!Number.isInteger(rows)) throw new MmlError("this length does not fit the row grid", at);
      defaultRows = rows;
    } else if (ch === "@") {
      const isDecay = peek() === "d";
      if (isDecay) i++;
      const v = number();
      if (v === null || v < 0 || v > 3) throw new MmlError(isDecay ? "decay must be 0 to 3" : "tone must be 0 to 3", at);
      if (isDecay) decay = v;
      else tone = v;
    } else if (ch === "v") {
      const v = number();
      if (v === null || v < 0 || v > 15) throw new MmlError("volume must be 0 to 15", at);
      vol = v;
    } else {
      throw new MmlError(`unknown command "${ch}"`, at);
    }
  }
  return { notes, rows: row };
}
