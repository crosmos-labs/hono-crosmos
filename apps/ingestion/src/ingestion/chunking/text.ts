/**
 * Text / markdown chunker — a recursive character splitter (issue #7).
 *
 * Until the full `chonkie` port lands, this keeps text/markdown sources from
 * being a single unbounded chunk. A single huge chunk was two latent bugs:
 *   - extraction could truncate (finish_reason=length → invalid JSON), and
 *   - the Stage-1 dedup-hint embed could exceed the embedder's input token limit.
 *
 * The splitter recursively breaks the text on increasingly fine separators
 * (paragraph → line → sentence → word) until each atom fits the hard cap, then
 * greedily merges atoms into chunks of roughly `targetChars`. Comparable in
 * granularity to the 4-turn conversation window.
 */
import { TEXT_CHUNK_MAX_CHARS, TEXT_CHUNK_TARGET_CHARS } from '../../constants';

const SEPARATORS = ['\n\n', '\n', '. ', ' '] as const;

/**
 * Break `text` into atoms each no longer than `maxChars`, splitting on the
 * coarsest separator that helps and recursing on any part still too long. Falls
 * back to a hard character split when no separator applies (e.g. one giant word).
 */
function splitToAtoms(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  for (const sep of SEPARATORS) {
    if (!text.includes(sep)) continue;
    const parts = text.split(sep).filter((p) => p.length > 0);
    if (parts.length < 2) continue;
    const atoms: string[] = [];
    for (const p of parts) {
      if (p.length <= maxChars) atoms.push(p);
      else atoms.push(...splitToAtoms(p, maxChars));
    }
    return atoms;
  }

  // No separator helped — hard split on character boundaries.
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/**
 * Split text/markdown into chunks of ~`targetChars`, never exceeding `maxChars`.
 * Returns [] for empty/whitespace-only input.
 */
export function chunkText(
  content: string,
  targetChars: number = TEXT_CHUNK_TARGET_CHARS,
  maxChars: number = TEXT_CHUNK_MAX_CHARS,
): string[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.length <= targetChars) return [trimmed];

  const atoms = splitToAtoms(trimmed, maxChars);
  const chunks: string[] = [];
  let buf = '';
  for (const atom of atoms) {
    if (buf.length === 0) {
      buf = atom;
    } else if (buf.length + 1 + atom.length <= targetChars) {
      buf = `${buf}\n${atom}`;
    } else {
      chunks.push(buf);
      buf = atom;
    }
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}
