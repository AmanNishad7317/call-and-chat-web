/**
 * ConnectNow Ephemeral Web Crypto API E2EE Engine (Zero Persistent Storage)
 * Keys exist ONLY in RAM for the duration of the 1-time number session.
 */
(function (global) {
  function b64uEncode(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function b64uDecode(str) {
    const pad = '='.repeat((4 - (str.length % 4)) % 4);
    const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function canonicalJwkStr(jwk) {
    return JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  }

  class EphemeralSessionCrypto {
    constructor() {
      this.identityPair = null;
      this.ecdhPair = null;
      this.identityPubJwk = null;
      this.ecdhPubJwk = null;
      this.peerIdentityJwk = null;
      this.peerEcdhJwk = null;
      this.sharedAesKey = null;
      this.seenMsgIds = new Set();
    }

    async init() {
      this.identityPair = await crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['sign', 'verify']
      );
      this.ecdhPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits', 'deriveKey']
      );
      this.identityPubJwk = await crypto.subtle.exportKey('jwk', this.identityPair.publicKey);
      this.ecdhPubJwk = await crypto.subtle.exportKey('jwk', this.ecdhPair.publicKey);
      return {
        identityPubJwk: this.identityPubJwk,
        ecdhPubJwk: this.ecdhPubJwk,
      };
    }

    async getSignedHandshake() {
      const payload = canonicalJwkStr(this.ecdhPubJwk);
      const sig = await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        this.identityPair.privateKey,
        new TextEncoder().encode(payload)
      );
      return {
        identityPubJwk: this.identityPubJwk,
        ecdhPubJwk: this.ecdhPubJwk,
        sig: b64uEncode(sig),
      };
    }

    async acceptPeerHandshake(handshake, roomNumber) {
      const pubKey = await crypto.subtle.importKey(
        'jwk',
        handshake.identityPubJwk,
        { name: 'ECDSA', namedCurve: 'P-256' },
        false,
        ['verify']
      );
      const valid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        pubKey,
        b64uDecode(handshake.sig),
        new TextEncoder().encode(canonicalJwkStr(handshake.ecdhPubJwk))
      );
      if (!valid) throw new Error('Peer key signature verification failed!');

      this.peerIdentityJwk = handshake.identityPubJwk;
      this.peerEcdhJwk = handshake.ecdhPubJwk;

      const peerEcdh = await crypto.subtle.importKey(
        'jwk',
        this.peerEcdhJwk,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
      );
      const sharedBits = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: peerEcdh },
        this.ecdhPair.privateKey,
        256
      );
      const hkdfKey = await crypto.subtle.importKey('raw', sharedBits, 'HKDF', false, ['deriveKey']);
      this.sharedAesKey = await crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: new TextEncoder().encode(`ConnectNow-Room-${roomNumber}`),
          info: new TextEncoder().encode('ConnectNow-Ephemeral-AES-GCM-256'),
        },
        hkdfKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );

      return await this.computeSafetyNumber();
    }

    async computeSafetyNumber() {
      const a = canonicalJwkStr(this.identityPubJwk);
      const b = canonicalJwkStr(this.peerIdentityJwk);
      const combined = a < b ? `${a}|${b}` : `${b}|${a}`;
      let buf = new TextEncoder().encode(combined);
      for (let i = 0; i < 64; i++) {
        buf = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
      }
      let digits = '';
      for (let i = 0; i < 30; i++) {
        const v = ((buf[i % 32] << 8) | buf[(i + 1) % 32]) % 100;
        digits += String(v).padStart(2, '0');
      }
      const safetyNumber = (digits.match(/.{1,5}/g) || []).join(' ');
      const fingerprintHex = Array.from(buf.slice(0, 12))
        .map((x) => x.toString(16).padStart(2, '0').toUpperCase())
        .join(':');
      return { safetyNumber, fingerprintHex };
    }

    async encryptMessage(obj) {
      if (!this.sharedAesKey) throw new Error('E2EE session not established yet');
      const msgId = b64uEncode(crypto.getRandomValues(new Uint8Array(12)));
      const ts = Date.now();
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const aad = new TextEncoder().encode(`${msgId}|${ts}`);
      const pt = new TextEncoder().encode(JSON.stringify(obj));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        this.sharedAesKey,
        pt
      );
      return { msgId, ts, iv: b64uEncode(iv), ct: b64uEncode(ct) };
    }

    async decryptMessage(pkt) {
      if (!this.sharedAesKey) throw new Error('E2EE session not established');
      if (this.seenMsgIds.has(pkt.msgId)) throw new Error('Replay message blocked');
      this.seenMsgIds.add(pkt.msgId);
      const iv = b64uDecode(pkt.iv);
      const ct = b64uDecode(pkt.ct);
      const aad = new TextEncoder().encode(`${pkt.msgId}|${pkt.ts}`);
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad },
        this.sharedAesKey,
        ct
      );
      return JSON.parse(new TextDecoder().decode(pt));
    }

    destroy() {
      this.identityPair = null;
      this.ecdhPair = null;
      this.sharedAesKey = null;
      this.peerIdentityJwk = null;
      this.peerEcdhJwk = null;
      this.seenMsgIds.clear();
    }
  }

  global.EphemeralSessionCrypto = EphemeralSessionCrypto;
})(window);
