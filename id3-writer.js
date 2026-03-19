/**
 * id3-writer.js — Pure JS ID3v2.3 tag writer (ES module)
 *
 * No dependencies. Used by the background service worker to embed metadata
 * (title, artist, album art, lyrics, etc.) into MP3 files before saving.
 *
 * Spec reference: https://id3.org/id3v2.3.0
 */

'use strict';

const _enc = new TextEncoder();

// ── Binary frame helpers ──────────────────────────────────────────────────────

/**
 * Builds a single ID3v2.3 frame.
 * Frame sizes in v2.3 are regular big-endian integers (NOT syncsafe).
 */
function buildFrame(id, data) {
  const frame = new Uint8Array(10 + data.length);
  // Frame ID — 4 ASCII bytes
  for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
  // Size — 4 bytes, big-endian
  frame[4] = (data.length >>> 24) & 0xFF;
  frame[5] = (data.length >>> 16) & 0xFF;
  frame[6] = (data.length >>>  8) & 0xFF;
  frame[7] =  data.length         & 0xFF;
  // Flags — 0x00, 0x00 (already zero from new Uint8Array)
  // Data
  frame.set(data, 10);
  return frame;
}

/**
 * Text frame (TIT2, TPE1, TALB, TCON, TYER, …)
 * Encoding byte 0x03 = UTF-8. Technically only v2.4-official, but
 * all modern players (iTunes, VLC, Windows Media Player) accept it in v2.3.
 */
function textFrame(id, text) {
  if (!text) return null;
  const textBytes = _enc.encode(String(text));
  const data = new Uint8Array(1 + textBytes.length);
  data[0] = 0x03; // UTF-8
  data.set(textBytes, 1);
  return buildFrame(id, data);
}

/**
 * COMM — Comment frame.
 * Structure: encoding(1) + language(3) + short_description\0 + text
 */
function commFrame(text) {
  if (!text) return null;
  const textBytes = _enc.encode(String(text));
  const data = new Uint8Array(5 + textBytes.length);
  data[0] = 0x03;            // UTF-8
  data[1] = 0x65;            // 'e'
  data[2] = 0x6E;            // 'n'
  data[3] = 0x67;            // 'g'
  data[4] = 0x00;            // empty short description (null terminator)
  data.set(textBytes, 5);
  return buildFrame('COMM', data);
}

/**
 * USLT — Unsynchronised lyrics / text transcription.
 * Structure: encoding(1) + language(3) + content_descriptor\0 + lyrics
 * Truncated to 5 000 chars to avoid bloating the tag.
 */
function usltFrame(lyrics) {
  if (!lyrics) return null;
  const lyricsBytes = _enc.encode(String(lyrics).substring(0, 5000));
  const data = new Uint8Array(5 + lyricsBytes.length);
  data[0] = 0x03; // UTF-8
  data[1] = 0x65; data[2] = 0x6E; data[3] = 0x67; // "eng"
  data[4] = 0x00; // empty content descriptor
  data.set(lyricsBytes, 5);
  return buildFrame('USLT', data);
}

/**
 * APIC — Attached picture (album art).
 * Structure: encoding(1) + MIME\0 + picture_type(1) + description\0 + image_bytes
 * picture_type 0x03 = Front cover.
 * Encoding 0x00 (ISO-8859-1) applies to the MIME type string and description —
 * the image data itself is raw binary, unaffected by the encoding byte.
 */
function apicFrame(imageData, mimeType) {
  if (!imageData) return null;
  const mimeBytes = _enc.encode(mimeType || 'image/jpeg');
  const imgBytes  = new Uint8Array(imageData);
  // encoding(1) + mime(n) + null(1) + picType(1) + desc_null(1) + image(n)
  const data = new Uint8Array(1 + mimeBytes.length + 1 + 1 + 1 + imgBytes.length);
  let i = 0;
  data[i++] = 0x00;                           // ISO-8859-1 (for mime + description)
  data.set(mimeBytes, i); i += mimeBytes.length;
  data[i++] = 0x00;                           // null-terminate MIME type
  data[i++] = 0x03;                           // picture type: front cover
  data[i++] = 0x00;                           // empty description (null terminator)
  data.set(imgBytes, i);
  return buildFrame('APIC', data);
}

// ── Header helpers ────────────────────────────────────────────────────────────

/**
 * Encodes a 28-bit integer as a 4-byte ID3 syncsafe integer.
 * Used only for the overall tag size in the ID3 header.
 */
function syncsafe(n) {
  return [
    (n >>> 21) & 0x7F,
    (n >>> 14) & 0x7F,
    (n >>>  7) & 0x7F,
     n         & 0x7F,
  ];
}

/**
 * Strips any existing ID3v2 tag from the front of mp3Bytes so we don't
 * end up with duplicate tags.
 */
function stripExistingId3(mp3Bytes) {
  if (mp3Bytes[0] !== 0x49 || mp3Bytes[1] !== 0x44 || mp3Bytes[2] !== 0x33) {
    return mp3Bytes; // no ID3 header present
  }
  // Syncsafe size is at bytes 6-9
  const tagSize =
    ((mp3Bytes[6] & 0x7F) << 21) |
    ((mp3Bytes[7] & 0x7F) << 14) |
    ((mp3Bytes[8] & 0x7F) <<  7) |
     (mp3Bytes[9] & 0x7F);
  return mp3Bytes.slice(10 + tagSize);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Builds a new ID3v2.3-tagged MP3 Blob from raw MP3 data + metadata.
 *
 * @param {ArrayBuffer} mp3Data       Raw MP3 bytes from the CDN
 * @param {object}      meta
 * @param {string}      meta.title
 * @param {string}      meta.artist
 * @param {string}      meta.album
 * @param {string}      meta.genre
 * @param {string}      meta.year           Four-digit year string
 * @param {string}      meta.comment
 * @param {string}      meta.lyrics         Prompt / lyrics text
 * @param {ArrayBuffer|null} meta.coverArt  JPEG/PNG image bytes (or null)
 * @param {string}      meta.coverMimeType  e.g. "image/jpeg"
 * @returns {Blob}  audio/mpeg Blob with ID3v2.3 tag prepended
 */
export function createTaggedMp3(mp3Data, meta) {
  const mp3Bytes = stripExistingId3(new Uint8Array(mp3Data));

  // Build frames — filter out any that returned null (empty fields)
  const frames = [
    textFrame('TIT2', meta.title),
    textFrame('TPE1', meta.artist),
    textFrame('TALB', meta.album),
    textFrame('TCON', meta.genre),
    textFrame('TYER', meta.year),
    commFrame(meta.comment),
    usltFrame(meta.lyrics),
    apicFrame(meta.coverArt, meta.coverMimeType),
  ].filter(Boolean);

  const framesSize    = frames.reduce((s, f) => s + f.length, 0);
  const PADDING       = 512; // let tag editors grow the tag without rewriting the file
  const tagBodySize   = framesSize + PADDING;  // size encoded in header (excludes 10-byte header itself)

  // Build the 10-byte ID3v2.3 header
  const header = new Uint8Array(10);
  header[0] = 0x49; header[1] = 0x44; header[2] = 0x33; // "ID3"
  header[3] = 0x03; header[4] = 0x00;                   // version 2.3, revision 0
  header[5] = 0x00;                                      // flags: none
  const ss = syncsafe(tagBodySize);
  header[6] = ss[0]; header[7] = ss[1]; header[8] = ss[2]; header[9] = ss[3];

  // Assemble: ID3 header + frames + zero-padding + original MP3 bytes
  const out = new Uint8Array(10 + tagBodySize + mp3Bytes.length);
  let pos = 0;
  out.set(header, pos);              pos += 10;
  for (const f of frames) {
    out.set(f, pos);                 pos += f.length;
  }
  // padding bytes are already 0 (new Uint8Array is zero-initialised)
  pos += PADDING;
  out.set(mp3Bytes, pos);

  return new Blob([out], { type: 'audio/mpeg' });
}
