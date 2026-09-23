import { escapeCardText } from './card-layout.js';

export const RESULT_PAGE_SIZE = 1600;
/** Keep every source character, including surrogate pairs and whitespace. */
export function resultPages(text: string): string[] {
  const pages: string[] = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + RESULT_PAGE_SIZE, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline > start + RESULT_PAGE_SIZE / 2) end = newline + 1;
      if (/[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
    }
    pages.push(text.slice(start, end));
    start = end;
  }
  return pages.length ? pages : [''];
}

type Fence = { char: string; count: number; language: string };
function fence(line: string, current?: Fence): Fence | undefined {
  const match = line.match(/^\s{0,3}(`{3,}|~{3,})([^\n]*)$/);
  if (!match) return current;
  if (current)
    return match[1]![0] === current.char && match[1]!.length >= current.count && !match[2]!.trim()
      ? undefined
      : current;
  return {
    char: match[1]![0]!,
    count: match[1]!.length,
    language: /^[a-zA-Z0-9_+-]{0,24}$/.test(match[2]!.trim()) ? match[2]!.trim() : '',
  };
}
function inline(text: string): string {
  // Only code spans and strong emphasis are emitted; links, HTML and mentions stay literal.
  return text
    .split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g)
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`')) return '`' + part.slice(1, -1) + '`';
      if (part.startsWith('**') && part.endsWith('**'))
        return '**' + escapeCardText(part.slice(2, -2)) + '**';
      return escapeCardText(part);
    })
    .join('');
}
/** A small allowlist, not arbitrary model-authored card markup. Reopen code on page boundaries. */
export function resultMarkdown(pages: string[], page: number): string {
  let current: Fence | undefined;
  for (const line of pages.slice(0, page).join('').split('\n')) current = fence(line, current);
  const output: string[] = [];
  for (const line of (pages[page] ?? '').split('\n')) {
    const next = fence(line, current);
    if (next !== current) output.push('');
    else if (current) output.push('    ' + line);
    else {
      const heading = line.match(/^#{1,6}\s+(.*)$/);
      const bullet = line.match(/^(\s*)(?:[-*+]\s+)(.*)$/);
      output.push(
        heading
          ? '**' + escapeCardText(heading[1]!) + '**'
          : bullet
            ? bullet[1] + '- ' + inline(bullet[2]!)
            : inline(line),
      );
    }
    current = next;
  }
  return output.join('\n');
}
