/**
 * A text file's bytes as text (ported from App-Milyonus
 * `candidate/import.service.ts`, decodeText).
 *
 * A byte-order mark says UTF-16; otherwise UTF-8 when the bytes are valid
 * UTF-8, and Windows-1254 when they are not — what older Turkish Excel
 * writes a CSV in.
 */
export function decodeText(data: Uint8Array): string {
  if (data[0] === 0xff && data[1] === 0xfe) return new TextDecoder('utf-16le').decode(data);
  if (data[0] === 0xfe && data[1] === 0xff) return new TextDecoder('utf-16be').decode(data);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('windows-1254').decode(data);
  }
}
