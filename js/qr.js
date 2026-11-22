/**
 * ConnectNow Offline QR Code SVG Renderer (Byte Mode, Version 1-4, ECC-L)
 * Renders standard scannable QR codes locally without external CDNs.
 */
(function (global) {
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];

  function gfMul(a, b) {
    return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function rsGenerator(degree) {
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      const factor = GF_EXP[i];
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= poly[j];
        next[j + 1] ^= gfMul(poly[j], factor);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecCount) {
    const gen = rsGenerator(ecCount);
    const res = new Uint8Array(data.length + ecCount);
    res.set(data, 0);
    for (let i = 0; i < data.length; i++) {
      const coef = res[i];
      if (coef !== 0) {
        for (let j = 0; j < gen.length; j++) {
          res[i + j] ^= gfMul(gen[j], coef);
        }
      }
    }
    return res.slice(data.length);
  }

  // Version specs for ECC-L: [version, size, totalDataBytes, ecBytes, alignPos]
  const SPECS = [
    [1, 21, 19, 7, []],
    [2, 25, 34, 10, [6, 18]],
    [3, 29, 55, 15, [6, 22]],
    [4, 33, 80, 20, [6, 26]],
    [5, 37, 108, 26, [6, 30]],
  ];

  function createMatrix(text) {
    const bytes = new TextEncoder().encode(text);
    const spec = SPECS.find((s) => bytes.length + 3 <= s[2]) || SPECS[SPECS.length - 1];
    const [ver, size, dataBytes, ecBytes, align] = spec;
    const clipped = bytes.slice(0, dataBytes - 3);

    const bits = [];
    const pushBits = (val, len) => {
      for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
    };
    pushBits(0b0100, 4); // Byte mode
    pushBits(clipped.length, 8);
    for (const b of clipped) pushBits(b, 8);
    pushBits(0, Math.min(4, dataBytes * 8 - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = new Uint8Array(dataBytes);
    for (let i = 0; i < bits.length / 8; i++) {
      let v = 0;
      for (let b = 0; b < 8; b++) v = (v << 1) | bits[i * 8 + b];
      codewords[i] = v;
    }
    const pads = [0xec, 0x11];
    for (let i = bits.length / 8, p = 0; i < dataBytes; i++, p++) {
      codewords[i] = pads[p % 2];
    }

    const ec = rsEncode(codewords, ecBytes);
    const allBytes = new Uint8Array(dataBytes + ecBytes);
    allBytes.set(codewords, 0);
    allBytes.set(ec, dataBytes);

    const m = Array.from({ length: size }, () => new Int8Array(size).fill(-1));
    const fixed = Array.from({ length: size }, () => new Uint8Array(size));

    const setMod = (r, c, val, isFixed = true) => {
      if (r >= 0 && r < size && c >= 0 && c < size) {
        m[r][c] = val ? 1 : 0;
        if (isFixed) fixed[r][c] = 1;
      }
    };

    const drawFinder = (r0, c0) => {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
          const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
          const inInner = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          setMod(r0 + r, c0 + c, inOuter && (onBorder || inInner));
        }
      }
    };

    drawFinder(0, 0);
    drawFinder(0, size - 7);
    drawFinder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) {
      setMod(6, i, i % 2 === 0);
      setMod(i, 6, i % 2 === 0);
    }
    setMod(size - 8, 8, 1);

    if (align.length) {
      const pos = align[1];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          setMod(pos + r, pos + c, Math.abs(r) === 2 || Math.abs(c) === 2 || (r === 0 && c === 0));
        }
      }
    }

    // Reserve format info
    for (let i = 0; i < 9; i++) {
      if (!fixed[8][i]) fixed[8][i] = 1;
      if (!fixed[i][8]) fixed[i][8] = 1;
    }
    for (let i = size - 8; i < size; i++) {
      fixed[8][i] = 1;
      fixed[i][8] = 1;
    }

    // Place data bits (mask 0: (r + c) % 2 === 0)
    let bitIdx = 0;
    const totalBits = allBytes.length * 8;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      const up = ((size - 1 - col) >> 1) % 2 === 0;
      for (let i = 0; i < size; i++) {
        const r = up ? size - 1 - i : i;
        for (let dc = 0; dc < 2; dc++) {
          const c = col - dc;
          if (!fixed[r][c]) {
            let bit = 0;
            if (bitIdx < totalBits) {
              bit = (allBytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
              bitIdx++;
            }
            if ((r + c) % 2 === 0) bit ^= 1;
            m[r][c] = bit;
          }
        }
      }
    }

    // Format info for ECC-L (01) + Mask 0 (000) -> 0x77c4 (with BCH + mask 0x5412)
    const fmt = 0x77c4;
    for (let i = 0; i < 15; i++) {
      const bit = (fmt >> i) & 1;
      if (i < 6) m[i][8] = bit;
      else if (i < 8) m[i + 1][8] = bit;
      else m[size - 15 + i][8] = bit;

      if (i < 8) m[8][size - i - 1] = bit;
      else if (i < 9) m[8][15 - i] = bit;
      else m[8][15 - i - 1] = bit;
    }
    return m;
  }

  function renderQRToSvg(text, pixelSize = 180) {
    const m = createMatrix(text);
    const n = m.length;
    const quiet = 2;
    const total = n + quiet * 2;
    let paths = '';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (m[r][c] === 1) {
          paths += `M${c + quiet},${r + quiet}h1v1h-1z`;
        }
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" style="background:#ffffff;border-radius:12px;"><path d="${paths}" fill="#081526"/></svg>`;
  }

  global.ConnectNowQR = { renderQRToSvg };
})(window);
