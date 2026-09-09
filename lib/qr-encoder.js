/* =====================================================
   lib/qr-encoder.js -- self-contained QR code encoder.

   No CDN calls, no external dependencies, no fetch, no image
   API round-trips. Vendored into lib/ so the desktop "Mobile
   counting app" card in js/26-page-cycle-counts.js can render
   a scannable QR to a plain <canvas> element without any
   network activity.

   Scope (kept intentionally small so this file stays reviewable):
     * Byte mode only (UTF-8 encoded input). Works for URLs.
     * ECC level L (lowest -- fine for a URL displayed on a
       supervisor screen; higher ECC would just shrink capacity).
     * Versions 1..10 (fits URLs up to 271 bytes at v10-L, which
       covers a Netlify subdomain + "/count" with room to spare).
     * Standard 8-mask evaluation using the ISO/IEC 18004 penalty
       rules so the encoder picks the mask a phone camera scans
       most reliably.

   Public API:
     QREncoder.toCanvas(canvas, text, { moduleSize = 4, margin = 4 })
       Draws the QR into the given HTMLCanvasElement. Resizes the
       canvas as needed. Uses black for on-modules and white for
       off-modules so it scans in bright light and dark alike.
     QREncoder.encode(text) -> { size, modules, version, mask }
       Returns the raw module matrix (boolean 2-D array) for
       callers that want to draw somewhere other than a canvas.

   The encoder follows the ISO/IEC 18004 spec (public
   International Standard). All tables in this file are that
   standard's data -- alignment centers, error-correction block
   layouts, format / version info generator polynomials.
   ===================================================== */

(function (root) {
  "use strict";

  // ---------- Galois field GF(256) with primitive 0x11d ---------
  const EXP = new Uint8Array(512);
  const LOG = new Uint16Array(256);
  (function initGf() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gfMul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  // ---------- Reed-Solomon generator + encode ------------------
  const rsGenCache = {};
  function rsGen(degree) {
    if (rsGenCache[degree]) return rsGenCache[degree];
    let g = new Uint8Array([1]);
    for (let i = 0; i < degree; i++) {
      const next = new Uint8Array(g.length + 1);
      for (let j = 0; j < g.length; j++) {
        next[j] ^= g[j];
        next[j + 1] ^= gfMul(g[j], EXP[i]);
      }
      g = next;
    }
    return (rsGenCache[degree] = g);
  }
  function rsEncode(data, eccLen) {
    const gen = rsGen(eccLen);
    const buf = new Uint8Array(data.length + eccLen);
    buf.set(data);
    for (let i = 0; i < data.length; i++) {
      const factor = buf[i];
      if (factor !== 0) {
        for (let j = 0; j < gen.length; j++) {
          buf[i + j] ^= gfMul(gen[j], factor);
        }
      }
    }
    return buf.subarray(data.length);
  }

  // ---------- Per-version tables for ECC level L ---------------
  // { ecc: EC codewords per block, groups: [[block count, data
  //   codewords per block], ...] }.  Source: ISO/IEC 18004 Table 9.
  const L_TABLE = [
    /*v1*/  { ecc: 7,  groups: [[1, 19]] },
    /*v2*/  { ecc: 10, groups: [[1, 34]] },
    /*v3*/  { ecc: 15, groups: [[1, 55]] },
    /*v4*/  { ecc: 20, groups: [[1, 80]] },
    /*v5*/  { ecc: 26, groups: [[1, 108]] },
    /*v6*/  { ecc: 18, groups: [[2, 68]] },
    /*v7*/  { ecc: 20, groups: [[2, 78]] },
    /*v8*/  { ecc: 24, groups: [[2, 97]] },
    /*v9*/  { ecc: 30, groups: [[2, 116]] },
    /*v10*/ { ecc: 18, groups: [[2, 68], [2, 69]] },
  ];
  function versionDataBytes(v) {
    let sum = 0;
    for (const [c, per] of L_TABLE[v - 1].groups) sum += c * per;
    return sum;
  }

  // Alignment pattern centers per version. Position 6 is always
  // included; the outer positions come from the standard.
  const ALIGN_CENTERS = [
    [],                    // v1: none
    [6, 18],
    [6, 22],
    [6, 26],
    [6, 30],
    [6, 34],
    [6, 22, 38],
    [6, 24, 42],
    [6, 26, 46],
    [6, 28, 50],
  ];

  // Version info BCH(18, 6) values for v7..v10. Precomputed once
  // from the standard's version-info generator; hardcoded so we
  // don't need a general BCH encoder here.
  const VERSION_INFO = { 7: 0x07C94, 8: 0x085BC, 9: 0x09A99, 10: 0x0A4D3 };

  // Format info per mask at ECC level L, XOR'd with the 0x5412
  // mask per standard. 15 bits, LSB = position 0 in the placement
  // map. Values verified against public QR reference tables.
  const FORMAT_INFO_L = [
    0x77C4, 0x72F3, 0x7DAA, 0x789D,
    0x662F, 0x6318, 0x6C41, 0x6976,
  ];

  // ---------- Mask predicates (ISO/IEC 18004 Table 10) ----------
  const MASK_FUNCS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => (r * c) % 2 + (r * c) % 3 === 0,
    (r, c) => ((r * c) % 2 + (r * c) % 3) % 2 === 0,
    (r, c) => ((r + c) % 2 + (r * c) % 3) % 2 === 0,
  ];

  // ---------- Matrix helpers ------------------------------------
  function matrix(size) {
    const m = new Array(size);
    for (let i = 0; i < size; i++) m[i] = new Uint8Array(size);
    return m;
  }
  function matrixCopy(m) {
    const size = m.length;
    const out = new Array(size);
    for (let i = 0; i < size; i++) out[i] = new Uint8Array(m[i]);
    return out;
  }

  function placeFinder(M, R, r0, c0, size) {
    for (let dr = 0; dr < 7; dr++) {
      for (let dc = 0; dc < 7; dc++) {
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const on = (dr === 0 || dr === 6 || dc === 0 || dc === 6 ||
                    (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)) ? 1 : 0;
        M[r][c] = on;
        R[r][c] = 1;
      }
    }
  }
  function placeSeparators(M, R, size) {
    // 1-module wide white separator between each finder and the data.
    for (let i = 0; i < 8; i++) {
      // top-left
      if (i < size) { M[7][i] = 0; R[7][i] = 1; }
      if (i < size) { M[i][7] = 0; R[i][7] = 1; }
      // top-right
      const trCol = size - 8 + i;
      if (trCol >= 0 && trCol < size) { M[7][trCol] = 0; R[7][trCol] = 1; }
      if (i < 8)                       { M[i][size - 8] = 0; R[i][size - 8] = 1; }
      // bottom-left
      const blRow = size - 8 + i;
      if (i < 8)                       { M[size - 8][i] = 0; R[size - 8][i] = 1; }
      if (blRow >= 0 && blRow < size)  { M[blRow][7] = 0; R[blRow][7] = 1; }
    }
  }
  function placeAlignment(M, R, version, size) {
    const centers = ALIGN_CENTERS[version - 1];
    for (const cy of centers) {
      for (const cx of centers) {
        // Skip if overlapping a finder pattern.
        if ((cy < 8 && cx < 8) ||
            (cy < 8 && cx > size - 9) ||
            (cy > size - 9 && cx < 8)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const on = (Math.abs(dy) === 2 || Math.abs(dx) === 2 || (dy === 0 && dx === 0)) ? 1 : 0;
            M[cy + dy][cx + dx] = on;
            R[cy + dy][cx + dx] = 1;
          }
        }
      }
    }
  }
  function placeTiming(M, R, size) {
    for (let i = 8; i < size - 8; i++) {
      const on = i % 2 === 0 ? 1 : 0;
      if (!R[6][i]) { M[6][i] = on; R[6][i] = 1; }
      if (!R[i][6]) { M[i][6] = on; R[i][6] = 1; }
    }
  }
  function reserveFormat(R, size) {
    for (let i = 0; i < 9; i++) { R[8][i] = 1; R[i][8] = 1; }
    for (let i = 0; i < 8; i++) { R[8][size - 1 - i] = 1; R[size - 1 - i][8] = 1; }
  }
  function reserveVersion(R, size) {
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 3; j++) {
        R[i][size - 11 + j] = 1;
        R[size - 11 + j][i] = 1;
      }
    }
  }

  function writeFormat(M, size, mask) {
    const fmt = FORMAT_INFO_L[mask];
    // Bit index -> (row, col) placement per ISO/IEC 18004. LSB at
    // position 0. Two copies of the 15-bit format written per code:
    //   1. Around the top-left finder (row 8 across, then col 8 up)
    //   2. Split TR/BL: bits 0..6 along col 8 from bottom, bits 7..14
    //      along row 8 from the right.
    for (let i = 0; i < 15; i++) {
      const b = (fmt >> i) & 1;
      // TL placement.
      if      (i < 6)   M[8][i]        = b;
      else if (i === 6) M[8][7]        = b;
      else if (i === 7) M[8][8]        = b;
      else if (i === 8) M[7][8]        = b;
      else              M[14 - i][8]   = b;  // i=9..14 -> rows 5..0
      // Split placement.
      if (i < 8) M[size - 1 - i][8] = b;      // i=0..7 -> rows size-1..size-8, col 8
      else       M[8][size - 15 + i] = b;     // i=8..14 -> row 8, cols size-7..size-1
    }
    // Dark module -- always at (4*version+9, 8) which for our
    // versions is exactly (size-8, 8).
    M[size - 8][8] = 1;
  }

  function writeVersion(M, size, version) {
    if (version < 7) return;
    const info = VERSION_INFO[version];
    for (let i = 0; i < 18; i++) {
      const b = (info >> i) & 1;
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      M[r][c] = b;
      M[c][r] = b;
    }
  }

  function placeData(M, R, size, bits, mask) {
    let bitIdx = 0;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--; // skip vertical timing column
      for (let step = 0; step < size; step++) {
        const row = upward ? size - 1 - step : step;
        for (let c = 0; c < 2; c++) {
          const cc = col - c;
          if (!R[row][cc]) {
            let bit = bitIdx < bits.length ? bits[bitIdx++] : 0;
            if (MASK_FUNCS[mask](row, cc)) bit ^= 1;
            M[row][cc] = bit;
          }
        }
      }
      upward = !upward;
    }
  }

  // ---------- Mask penalty evaluation (ISO 18004 Table 11) -----
  function penalty(M, size) {
    let p = 0;
    // Rule 1: runs of 5+ same-color modules in a row / column.
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (M[r][c] === M[r][c - 1]) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
        else run = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (M[r][c] === M[r - 1][c]) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
        else run = 1;
      }
    }
    // Rule 2: 2x2 same-color blocks.
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = M[r][c];
        if (v === M[r][c + 1] && v === M[r + 1][c] && v === M[r + 1][c + 1]) p += 3;
      }
    }
    // Rule 3: finder-like patterns 1:1:3:1:1 with 4-wide light padding.
    const patA = [1,0,1,1,1,0,1,0,0,0,0];
    const patB = [0,0,0,0,1,0,1,1,1,0,1];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size - 10; c++) {
        let ok = true;
        for (let i = 0; i < 11; i++) if (M[r][c + i] !== patA[i]) { ok = false; break; }
        if (ok) p += 40;
        ok = true;
        for (let i = 0; i < 11; i++) if (M[r][c + i] !== patB[i]) { ok = false; break; }
        if (ok) p += 40;
      }
    }
    for (let c = 0; c < size; c++) {
      for (let r = 0; r < size - 10; r++) {
        let ok = true;
        for (let i = 0; i < 11; i++) if (M[r + i][c] !== patA[i]) { ok = false; break; }
        if (ok) p += 40;
        ok = true;
        for (let i = 0; i < 11; i++) if (M[r + i][c] !== patB[i]) { ok = false; break; }
        if (ok) p += 40;
      }
    }
    // Rule 4: dark-module ratio deviation from 50%.
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (M[r][c]) dark++;
    const ratio = dark / (size * size);
    const dev = Math.floor(Math.abs(ratio * 100 - 50) / 5);
    p += dev * 10;
    return p;
  }

  // ---------- Top-level encode ---------------------------------
  function encode(text) {
    // 1. UTF-8 encode text to bytes.
    const bytes = (typeof TextEncoder !== "undefined")
      ? new TextEncoder().encode(text)
      : (function () {
          // Fallback: assume ASCII-only.
          const out = new Uint8Array(text.length);
          for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
          return out;
        })();
    // 2. Choose smallest version that fits.
    let version = 0;
    for (let v = 1; v <= 10; v++) {
      const countBits = v <= 9 ? 8 : 16;
      const headerBits = 4 + countBits;
      const bitsNeeded = headerBits + bytes.length * 8;
      if (bitsNeeded <= versionDataBytes(v) * 8) { version = v; break; }
    }
    if (version === 0) throw new Error("QREncoder: input too long (max ~271 bytes at v10-L)");

    const spec = L_TABLE[version - 1];
    const totalDataBytes = versionDataBytes(version);

    // 3. Build bit stream.
    const bits = [];
    const push = (val, n) => { for (let i = n - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(0b0100, 4);                                 // byte mode
    push(bytes.length, version <= 9 ? 8 : 16);       // char count
    for (const b of bytes) push(b, 8);
    // Terminator: up to 4 zeros, then pad to byte boundary.
    for (let i = 0; i < 4 && bits.length < totalDataBytes * 8; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    // Pad codewords 0xEC / 0x11 alternating.
    let padSel = 0;
    while (bits.length < totalDataBytes * 8) {
      push(padSel === 0 ? 0xEC : 0x11, 8);
      padSel = 1 - padSel;
    }
    const dataBytes = new Uint8Array(totalDataBytes);
    for (let i = 0; i < totalDataBytes; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j];
      dataBytes[i] = b;
    }
    // 4. Split into blocks + compute EC.
    const dataBlocks = [];
    const eccBlocks = [];
    let cursor = 0;
    for (const [count, per] of spec.groups) {
      for (let k = 0; k < count; k++) {
        const blk = dataBytes.slice(cursor, cursor + per);
        cursor += per;
        dataBlocks.push(blk);
        eccBlocks.push(rsEncode(blk, spec.ecc));
      }
    }
    // 5. Interleave data + ECC into final bit stream.
    const finalBits = [];
    const maxData = Math.max.apply(null, dataBlocks.map(b => b.length));
    for (let i = 0; i < maxData; i++) {
      for (const b of dataBlocks) if (i < b.length) push_(finalBits, b[i], 8);
    }
    for (let i = 0; i < spec.ecc; i++) {
      for (const b of eccBlocks) push_(finalBits, b[i], 8);
    }
    // 6. Build matrix + place patterns.
    const size = 21 + (version - 1) * 4;
    const M0 = matrix(size);
    const R = matrix(size);
    placeFinder(M0, R, 0, 0, size);
    placeFinder(M0, R, 0, size - 7, size);
    placeFinder(M0, R, size - 7, 0, size);
    placeSeparators(M0, R, size);
    placeAlignment(M0, R, version, size);
    placeTiming(M0, R, size);
    reserveFormat(R, size);
    if (version >= 7) reserveVersion(R, size);

    // 7. Try all 8 masks, pick best.
    let best = null;
    let bestPen = Infinity;
    let bestMask = 0;
    for (let mask = 0; mask < 8; mask++) {
      const M = matrixCopy(M0);
      placeData(M, R, size, finalBits, mask);
      writeFormat(M, size, mask);
      writeVersion(M, size, version);
      const p = penalty(M, size);
      if (p < bestPen) { bestPen = p; best = M; bestMask = mask; }
    }
    return { size, modules: best, version, mask: bestMask };
  }

  function push_(arr, val, n) {
    for (let i = n - 1; i >= 0; i--) arr.push((val >> i) & 1);
  }

  // ---------- Canvas render ------------------------------------
  function toCanvas(canvas, text, opts) {
    opts = opts || {};
    const moduleSize = Math.max(1, Number(opts.moduleSize) || 4);
    const margin     = Math.max(0, Number(opts.margin) === 0 ? 0 : (Number(opts.margin) || 4));
    const dark  = opts.dark  || "#000000";
    const light = opts.light || "#ffffff";
    const qr = encode(text);
    const sizePx = (qr.size + margin * 2) * moduleSize;
    canvas.width = sizePx;
    canvas.height = sizePx;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, sizePx, sizePx);
    ctx.fillStyle = dark;
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (qr.modules[r][c]) {
          ctx.fillRect((c + margin) * moduleSize, (r + margin) * moduleSize, moduleSize, moduleSize);
        }
      }
    }
    return qr;
  }

  const api = { encode, toCanvas };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.QREncoder = api;
})(typeof self !== "undefined" ? self : (typeof global !== "undefined" ? global : this));
