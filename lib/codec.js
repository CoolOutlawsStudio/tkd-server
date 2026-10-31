// Serialises arena-store records ({brains, pool, history, meta}, the exact objects arena-worker.js hands to
// arena-store.js) for remote storage. Typed arrays become {"__ta":"Float32Array","b64":"..."} (lossless), the JSON is
// gzipped, and the stored payload is base64 text whose sha256 is checked on save (by SQL) and on load (here).
'use strict';
const zlib = require('zlib'), crypto = require('crypto');
const TA = { Float32Array, Float64Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Int8Array, Uint8Array, Uint8ClampedArray };
const FORMAT = 'tkd-arena-store-json-gz-b64/1';

function replacer(k, v) {
  if (v && ArrayBuffer.isView(v) && !(v instanceof DataView)) {
    return { __ta: v.constructor.name, b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  }
  return v;
}
function reviver(k, v) {
  if (v && typeof v === 'object' && typeof v.__ta === 'string' && typeof v.b64 === 'string' && TA[v.__ta]) {
    const buf = Buffer.from(v.b64, 'base64'), C = TA[v.__ta];
    const ab = new ArrayBuffer(buf.length); new Uint8Array(ab).set(buf); // aligned copy
    return new C(ab);
  }
  return v;
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function encode(obj) {
  const json = JSON.stringify(obj, replacer);
  const payload = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64');
  return { format: FORMAT, payload, sha256: sha256(payload), bytes: Buffer.byteLength(payload), jsonBytes: Buffer.byteLength(json) };
}
function decode(payload, expectSha) {
  if (typeof payload !== 'string') throw new Error('payload is not text');
  const got = sha256(payload);
  if (expectSha && got !== expectSha) throw new Error('sha256 mismatch: stored ' + String(expectSha).slice(0, 8) + ', got ' + got.slice(0, 8));
  return JSON.parse(zlib.gunzipSync(Buffer.from(payload, 'base64')).toString('utf8'), reviver);
}
module.exports = { encode, decode, sha256, FORMAT };
