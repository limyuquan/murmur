/**
 * Decode-only Qwen2 byte-level BPE tokenizer: token id → token string (vocab.json + added tokens)
 * → GPT-2 byte decoder → UTF-8. The ASR prompt ids are constants, so no encoder is needed.
 * From the Qwen3-ASR browser spike; checked against the Hugging Face tokenizer.
 */
export class TokenDecoder {
  private readonly pieces: string[] = [];
  private readonly special = new Set<number>();
  private static byteDecoder: Map<string, number> | null = null;

  constructor(vocab: Record<string, number>, added: Record<string, number>) {
    for (const [piece, id] of Object.entries(vocab)) this.pieces[id] = piece;
    for (const [piece, id] of Object.entries(added)) {
      this.pieces[id] = piece;
      this.special.add(id);
    }
  }

  private static bytes(): Map<string, number> {
    if (TokenDecoder.byteDecoder) return TokenDecoder.byteDecoder;
    const bs: number[] = [];
    for (let b = 33; b <= 126; b++) bs.push(b);
    for (let b = 161; b <= 172; b++) bs.push(b);
    for (let b = 174; b <= 255; b++) bs.push(b);
    const cs = [...bs];
    let n = 0;
    for (let b = 0; b < 256; b++) {
      if (!bs.includes(b)) {
        bs.push(b);
        cs.push(256 + n++);
      }
    }
    const m = new Map<string, number>();
    bs.forEach((b, i) => {
      m.set(String.fromCodePoint(cs[i] as number), b);
    });
    TokenDecoder.byteDecoder = m;
    return m;
  }

  piece(id: number): string {
    return this.pieces[id] ?? '';
  }

  decode(ids: number[], skipSpecial = true): string {
    const bd = TokenDecoder.bytes();
    const out: number[] = [];
    let text = '';
    // At the very end, an incomplete character (an answer cut mid-character) is left out.
    const flush = (end = false) => {
      if (out.length) text += new TextDecoder().decode(Uint8Array.from(out), { stream: end });
      out.length = 0;
    };
    for (const id of ids) {
      if (this.special.has(id)) {
        if (!skipSpecial) {
          flush();
          text += this.pieces[id] ?? '';
        }
        continue;
      }
      for (const ch of this.pieces[id] ?? '') {
        const b = bd.get(ch);
        if (b !== undefined) out.push(b);
      }
    }
    flush(true);
    return text;
  }
}
