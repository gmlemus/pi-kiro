// Splits inline reasoning tags out of assistant text (PROTOCOL.md §3.6).
// Tags may be split across network chunks, so any suffix that could be the
// start of a tag is held back until the next chunk decides it.

const PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["<thinking>", "</thinking>"],
  ["<reasoning>", "</reasoning>"],
  ["<thought>", "</thought>"],
];

export interface Segment {
  thinking: boolean;
  text: string;
}

/** Length of the longest suffix of `text` that is a proper prefix of one of `tags`. */
function partialTagSuffix(text: string, tags: readonly string[]): number {
  let best = 0;
  for (const tag of tags) {
    for (let n = Math.min(tag.length - 1, text.length); n > best; n--) {
      if (text.endsWith(tag.slice(0, n))) {
        best = n;
        break;
      }
    }
  }
  return best;
}

export class InlineThinkingSplitter {
  #buffer = "";
  #close: string | null = null;
  /** Drop the blank lines a model usually writes right after a closing tag. */
  #trimNext = false;

  feed(chunk: string): Segment[] {
    this.#buffer += chunk;
    const out: Segment[] = [];
    for (;;) {
      if (this.#close === null) {
        let at = -1;
        let pair: readonly [string, string] | undefined;
        for (const p of PAIRS) {
          const i = this.#buffer.indexOf(p[0]);
          if (i >= 0 && (at < 0 || i < at)) {
            at = i;
            pair = p;
          }
        }
        if (pair) {
          this.#text(out, this.#buffer.slice(0, at));
          this.#buffer = this.#buffer.slice(at + pair[0].length);
          this.#close = pair[1];
          continue;
        }
        const hold = partialTagSuffix(this.#buffer, PAIRS.map((p) => p[0]));
        this.#text(out, this.#buffer.slice(0, this.#buffer.length - hold));
        this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
        return out;
      }
      const at = this.#buffer.indexOf(this.#close);
      if (at >= 0) {
        if (at > 0) out.push({ thinking: true, text: this.#buffer.slice(0, at) });
        this.#buffer = this.#buffer.slice(at + this.#close.length);
        this.#close = null;
        this.#trimNext = true;
        continue;
      }
      const hold = partialTagSuffix(this.#buffer, [this.#close]);
      const emit = this.#buffer.slice(0, this.#buffer.length - hold);
      if (emit) out.push({ thinking: true, text: emit });
      this.#buffer = this.#buffer.slice(this.#buffer.length - hold);
      return out;
    }
  }

  /** Emit whatever is held back; an unclosed reasoning region stays reasoning. */
  flush(): Segment[] {
    const rest = this.#buffer;
    this.#buffer = "";
    if (!rest) return [];
    if (this.#close !== null) return [{ thinking: true, text: rest }];
    const out: Segment[] = [];
    this.#text(out, rest);
    return out;
  }

  #text(out: Segment[], text: string): void {
    if (this.#trimNext) {
      text = text.replace(/^\s+/, "");
      if (!text) return;
      this.#trimNext = false;
    }
    if (text) out.push({ thinking: false, text });
  }
}
