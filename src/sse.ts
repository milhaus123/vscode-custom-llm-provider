/** Minimal incremental SSE parser for OpenAI-compatible `data:` streams. */
export class SseDataParser {
  private buffer = '';

  push(text: string): string[] {
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? '';
    return this.dataFromLines(lines);
  }

  finish(text = ''): string[] {
    this.buffer += text;
    const lines = this.buffer ? this.buffer.split(/\r?\n/) : [];
    this.buffer = '';
    return this.dataFromLines(lines);
  }

  private dataFromLines(lines: readonly string[]): string[] {
    const result: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      result.push(trimmed.slice(5).trim());
    }
    return result;
  }
}
