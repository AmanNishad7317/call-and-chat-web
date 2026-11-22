/**
 * ConnectNow Ephemeral Pure HTML/CSS/JS App
 * - Zero server database / zero persistent message storage
 * - Strictly 2 users per secret number (-s1 and -s2); 3rd user rejected as Room Full
 * - User 1 waits as long as needed until User 2 connects
 * - Once disconnected, the number is burned and a new number is required
 * - 4G/5G Voice & Video calling via Metered TURN API + PeerJS
 * - Ephemeral E2EE chat via Web Crypto API (ECDH P-256 + ECDSA P-256 + AES-GCM-256)
 */
(function () {
  const $ = (id) => document.getElementById(id);

  let peer = null;
  let dataConn = null;
  let mediaConn = null;
  let localStream = null;
  let roomNumber = null;
  let mySlot = null; // 1 or 2
  let partnerPeerId = null;
  let sessionCrypto = null;
  let safetyInfo = null;
  let incomingCallRef = null;
  let incomingIsVideo = false;
  let activeCallIsVideo = false;
  let isMuted = false;
  let isCamOff = false;
  let facingMode = 'user';
  let callTimerInterval = null;
  let callSeconds = 0;
  let audioCtx = null;
  let ringInterval = null;
  let typingTimeout = null;
  let retryTimer = null;

  function showToast(msg, type = 'success') {
    const t = document.createElement('div');
    t.className = `toast ${type}`;
    t.textContent = msg;
    $('toast-container').appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
    $(id).classList.add('active');
  }

  function getMeteredKey() {
    const saved = (localStorage.getItem('cn_metered_key') || '').trim();
    const cfg = (window.CONNECTNOW_CONFIG?.METERED_API_KEY || '').trim();
    return saved || cfg;
  }

  function updateTurnHint() {
    const hasKey = Boolean(getMeteredKey());
    $('turn-status-hint').textContent = hasKey
      ? '4G/5G Metered TURN Relay configured.'
      : 'Using STUN fallback. Add your Metered API key in Settings for strict 4G/5G calls.';
  }

  async function fetchIceServers() {
    const apiKey = getMeteredKey();
    if (!apiKey) return window.CONNECTNOW_CONFIG.STUN_SERVERS;
    try {
      const res = await fetch(`https://metered.ca/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`);
      if (!res.ok) throw new Error('Metered API error');
      return await res.json();
    } catch {
      showToast('TURN fetch failed; using STUN fallback', 'error');
      return window.CONNECTNOW_CONFIG.STUN_SERVERS;
    }
  }

  function playRingtone() {
    stopRingtone();
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(520, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.45);
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start();
        osc.stop(audioCtx.currentTime + 0.45);
      };
      beep();
      ringInterval = setInterval(beep, 1800);
    } catch {}
  }

  function stopRingtone() {
    clearInterval(ringInterval);
    ringInterval = null;
  }

  function updatePartnerUI(connected) {
    const dot = $('connection-dot');
    dot.classList.remove('online', 'waiting');
    dot.classList.add(connected ? 'online' : 'waiting');
    $('chat-status-text').textContent = connected ? 'Connected · E2EE' : 'Waiting for partner...';
    $('message-input').disabled = !connected;
    $('message-input').placeholder = connected ? 'Encrypted message...' : 'Waiting for partner...';
    $('send-btn').disabled = !connected || !$('message-input').value.trim();
    $('start-voice-btn').disabled = !connected;
    $('start-video-btn').disabled = !connected;
    $('verify-safety-btn').disabled = !connected;
    $('e2ee-badge').textContent = connected ? 'E2EE Verified' : 'Waiting...';
    $('e2ee-badge').className = connected ? 'badge-ready' : 'badge-waiting';
  }

  // ================= 2-USER SLOT NEGOTIATION & ONE-TIME BURN =================
  async function joinSecretRoom(num) {
    roomNumber = num;
    $('chat-room-title').textContent = `Room #${num}`;
    $('chat-messages').innerHTML = '<div class="encryption-notice">Waiting for the second user to enter this secret number...</div>';
    updatePartnerUI(false);
    showScreen('chat-screen');

    sessionCrypto = new window.EphemeralSessionCrypto();
    await sessionCrypto.init();
    const iceServers = await fetchIceServers();

    claimSlot(1, iceServers);
  }

  function claimSlot(slot, iceServers) {
    const prefix = window.CONNECTNOW_CONFIG.PEER_PREFIX;
    const myId = `${prefix}${roomNumber}-s${slot}`;
    mySlot = slot;
    partnerPeerId = `${prefix}${roomNumber}-s${slot === 1 ? 2 : 1}`;

    if (peer) {
      try { peer.disconnect(); peer.destroy(); } catch {}
    }

    peer = new Peer(myId, {
      debug: 1,
      secure: location.protocol === 'https:',
      config: { iceServers, iceTransportPolicy: 'all' },
    });

    peer.on('open', () => {
      if (slot === 1) {
        showToast('Waiting for partner to enter the same number...');
      } else {
        showToast('Connecting to partner...');
        connectToPartner();
        clearInterval(retryTimer);
        retryTimer = setInterval(() => {
          if (!dataConn || !dataConn.open) connectToPartner();
        }, 3000);
      }
    });

    peer.on('connection', (conn) => {
      if (dataConn && dataConn.open) {
        conn.on('open', () => {
          conn.send({ type: 'room-full' });
          setTimeout(() => conn.close(), 200);
        });
        return;
      }
      setupDataConnection(conn);
    });

    peer.on('call', (call) => handleIncomingCall(call));

    peer.on('error', (err) => {
      if (err.type === 'unavailable-id') {
        if (slot === 1) {
          claimSlot(2, iceServers);
        } else {
          showToast('This number is currently busy (2 users already connected). Use a new number.', 'error');
          destroySession(false);
        }
      } else if (err.type === 'peer-unavailable') {
        updatePartnerUI(false);
      }
    });
  }

  function connectToPartner() {
    if (peer && !peer.destroyed && partnerPeerId) {
      const conn = peer.connect(partnerPeerId, { reliable: true });
      setupDataConnection(conn);
    }
  }

  function setupDataConnection(conn) {
    dataConn = conn;

    conn.on('open', async () => {
      clearInterval(retryTimer);
      const hs = await sessionCrypto.getSignedHandshake();
      conn.send({ type: 'e2ee-handshake', payload: hs });
    });

    conn.on('data', async (data) => {
      if (data.type === 'room-full') {
        showToast('Room is full (2 users max). Use another number.', 'error');
        destroySession(false);
        return;
      }
      if (data.type === 'e2ee-handshake') {
        try {
          safetyInfo = await sessionCrypto.acceptPeerHandshake(data.payload, roomNumber);
          updatePartnerUI(true);
          $('chat-messages').innerHTML = '<div class="encryption-notice">Connected! Ephemeral E2EE (ECDH + AES-GCM-256) active.</div>';
          showToast('Partner connected securely!');
        } catch (err) {
          showToast(err.message, 'error');
          destroySession(true);
        }
        return;
      }
      if (data.type === 'e2ee-msg') {
        try {
          const pt = await sessionCrypto.decryptMessage(data.payload);
          appendMessage(pt.text, 'received', data.payload.ts, pt.ttl);
        } catch {
          showToast('Blocked unauthenticated message', 'error');
        }
        return;
      }
      if (data.type === 'typing') {
        $('typing-indicator').classList.toggle('hidden', !data.typing);
        return;
      }
      if (data.type === 'call-reject') {
        cleanupCallUI();
        showToast('Call declined', 'error');
        return;
      }
      if (data.type === 'call-end') {
        cleanupCallUI();
        showToast('Call ended');
        return;
      }
      if (data.type === 'session-ended') {
        showToast('Partner disconnected. Session ended.', 'error');
        destroySession(true);
      }
    });

    conn.on('close', () => {
      if (roomNumber) {
        showToast('Connection closed. Enter a new number for a new session.', 'error');
        destroySession(true);
      }
    });
  }

  function destroySession(burn = true) {
    clearInterval(retryTimer);
    if (dataConn && dataConn.open) {
      try { dataConn.send({ type: 'session-ended' }); dataConn.close(); } catch {}
    }
    dataConn = null;
    cleanupCallUI();
    if (peer) {
      try { peer.disconnect(); peer.destroy(); } catch {}
      peer = null;
    }
    if (sessionCrypto) {
      sessionCrypto.destroy();
      sessionCrypto = null;
    }
    safetyInfo = null;
    roomNumber = null;
    $('room-number-input').value = '';
    $('chat-messages').innerHTML = '';
    showScreen('welcome-screen');
  }

  // ================= CHAT MESSAGES =================
  async function sendEncryptedChat() {
    const text = $('message-input').value.trim();
    if (!text || !dataConn || !dataConn.open || !sessionCrypto) return;
    const ttl = parseInt($('disappear-select').value || '0', 10);
    const pkt = await sessionCrypto.encryptMessage({ text, ttl });
    dataConn.send({ type: 'e2ee-msg', payload: pkt });
    appendMessage(text, 'sent', pkt.ts, ttl);
    $('message-input').value = '';
    $('send-btn').disabled = true;
    dataConn.send({ type: 'typing', typing: false });
  }

  function appendMessage(text, type, ts, ttl = 0) {
    const wrap = document.createElement('div');
    wrap.className = `message-wrapper ${type}`;
    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = text;

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    meta.textContent = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    const del = document.createElement('button');
    del.className = 'msg-del-btn';
    del.textContent = 'Delete';
    del.addEventListener('click', () => wrap.remove());
    meta.appendChild(del);

    wrap.appendChild(bubble);
    wrap.appendChild(meta);
    $('chat-messages').appendChild(wrap);
    $('chat-messages').scrollTop = $('chat-messages').scrollHeight;

    if (ttl > 0) {
      setTimeout(() => wrap.remove(), ttl * 1000);
    }
  }

  $('message-input').addEventListener('input', () => {
    const val = $('message-input').value.trim();
    $('send-btn').disabled = !val || !dataConn || !dataConn.open;
    if (dataConn && dataConn.open) {
      dataConn.send({ type: 'typing', typing: Boolean(val) });
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(() => {
        if (dataConn && dataConn.open) dataConn.send({ type: 'typing', typing: false });
      }, 1500);
    }
  });
  $('send-btn').addEventListener('click', sendEncryptedChat);
  $('message-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendEncryptedChat();
  });
  $('clear-chat-btn').addEventListener('click', () => {
    $('chat-messages').innerHTML = '<div class="encryption-notice">Chat cleared locally.</div>';
  });

  // ================= VOICE & VIDEO CALLING =================
  async function getMedia(isVideo) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: isVideo ? { facingMode } : false,
      });
    } catch {
      showToast('Camera/Microphone permission required', 'error');
      return null;
    }
  }

  async function initiateCall(isVideo) {
    if (!dataConn || !dataConn.open) {
      showToast('Partner is not connected', 'error');
      return;
    }
    localStream = await getMedia(isVideo);
    if (!localStream) return;

    activeCallIsVideo = isVideo;
    setupCallScreenUI(isVideo, 'Calling...');
    playRingtone();
    mediaConn = peer.call(partnerPeerId, localStream, { metadata: { isVideo } });
    setupMediaEvents(mediaConn);
  }

  function setupCallScreenUI(isVideo, statusText) {
    $('call-type-label').textContent = isVideo ? 'Encrypted Video Call' : 'Encrypted Voice Call';
    $('call-status').textContent = statusText;
    $('call-timer').textContent = '00:00';
    $('remote-video').classList.toggle('hidden', !isVideo);
    $('local-video').classList.toggle('hidden', !isVideo);
    $('call-profile-box').classList.toggle('hidden', isVideo);
    $('cam-toggle-btn').classList.toggle('hidden', !isVideo);
    $('switch-cam-btn').classList.toggle('hidden', !isVideo);
    if (isVideo && localStream) {
      $('local-video').srcObject = localStream;
    }
    showScreen('call-screen');
  }

  function handleIncomingCall(call) {
    incomingCallRef = call;
    incomingIsVideo = Boolean(call.metadata?.isVideo);
    const stealth = $('stealth-toggle').checked;
    $('incoming-call-title').textContent = stealth ? 'Incoming Private Call' : `Room #${roomNumber}`;
    $('incoming-call-type').textContent = incomingIsVideo ? 'Encrypted Video Call' : 'Encrypted Voice Call';
    playRingtone();
    $('incoming-call-modal').classList.add('active');
  }

  $('accept-call-btn').addEventListener('click', async () => {
    stopRingtone();
    $('incoming-call-modal').classList.remove('active');
    if (!incomingCallRef) return;

    localStream = await getMedia(incomingIsVideo);
    if (!localStream) {
      incomingCallRef.close();
      return;
    }
    activeCallIsVideo = incomingIsVideo;
    setupCallScreenUI(incomingIsVideo, 'Connected');
    incomingCallRef.answer(localStream);
    mediaConn = incomingCallRef;
    setupMediaEvents(mediaConn);
  });

  $('reject-call-btn').addEventListener('click', () => {
    stopRingtone();
    $('incoming-call-modal').classList.remove('active');
    if (incomingCallRef) {
      incomingCallRef.close();
      incomingCallRef = null;
    }
    if (dataConn && dataConn.open) dataConn.send({ type: 'call-reject' });
  });

  function setupMediaEvents(conn) {
    conn.on('stream', (remoteStream) => {
      stopRingtone();
      $('call-status').textContent = 'Connected';
      if (activeCallIsVideo) {
        $('remote-video').srcObject = remoteStream;
      } else {
        $('remote-audio').srcObject = remoteStream;
      }
      clearInterval(callTimerInterval);
      callSeconds = 0;
      callTimerInterval = setInterval(() => {
        callSeconds++;
        const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
        const s = String(callSeconds % 60).padStart(2, '0');
        $('call-timer').textContent = `${m}:${s}`;
      }, 1000);
    });
    conn.on('close', () => cleanupCallUI());
    conn.on('error', () => cleanupCallUI());
  }

  function cleanupCallUI() {
    stopRingtone();
    clearInterval(callTimerInterval);
    callTimerInterval = null;
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }
    if (mediaConn) {
      try { mediaConn.close(); } catch {}
      mediaConn = null;
    }
    $('remote-audio').srcObject = null;
    $('remote-video').srcObject = null;
    $('local-video').srcObject = null;
    $('incoming-call-modal').classList.remove('active');
    isMuted = false;
    isCamOff = false;
    $('mute-btn').textContent = 'Mic On';
    $('cam-toggle-btn').textContent = 'Cam On';
    if (roomNumber) showScreen('chat-screen');
  }

  $('start-voice-btn').addEventListener('click', () => initiateCall(false));
  $('start-video-btn').addEventListener('click', () => initiateCall(true));
  $('end-call-btn').addEventListener('click', () => {
    if (dataConn && dataConn.open) dataConn.send({ type: 'call-end' });
    cleanupCallUI();
  });

  $('mute-btn').addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getAudioTracks()[0];
    if (!track) return;
    isMuted = !isMuted;
    track.enabled = !isMuted;
    $('mute-btn').textContent = isMuted ? 'Muted' : 'Mic On';
  });

  $('cam-toggle-btn').addEventListener('click', () => {
    if (!localStream) return;
    const track = localStream.getVideoTracks()[0];
    if (!track) return;
    isCamOff = !isCamOff;
    track.enabled = !isCamOff;
    $('cam-toggle-btn').textContent = isCamOff ? 'Cam Off' : 'Cam On';
  });

  $('switch-cam-btn').addEventListener('click', async () => {
    if (!localStream || !mediaConn) return;
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode }, audio: false });
    const newTrack = newStream.getVideoTracks()[0];
    const sender = mediaConn.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
    localStream.getVideoTracks().forEach((t) => t.stop());
    localStream.removeTrack(localStream.getVideoTracks()[0]);
    localStream.addTrack(newTrack);
    $('local-video').srcObject = localStream;
  });

  // ================= UI EVENTS, QR, PANIC, SETTINGS =================
  $('gen-number-btn').addEventListener('click', () => {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    $('room-number-input').value = String(100000 + (arr[0] % 900000));
  });

  $('share-number-qr-btn').addEventListener('click', () => {
    const num = $('room-number-input').value.trim();
    if (!num) {
      showToast('Enter or generate a number first', 'error');
      return;
    }
    $('qr-modal-title').textContent = 'Share Secret Number';
    $('qr-modal-subtitle').textContent = `Number: ${num}`;
    $('qr-digits').textContent = '';
    $('qr-svg-box').innerHTML = window.ConnectNowQR.renderQRToSvg(`connectnow:${num}`, 180);
    $('qr-modal').classList.add('active');
  });

  $('verify-safety-btn').addEventListener('click', () => {
    if (!safetyInfo) return;
    $('qr-modal-title').textContent = 'Verify E2EE Safety Number';
    $('qr-modal-subtitle').textContent = 'Compare this 60-digit number with your partner to confirm zero MITM.';
    $('qr-digits').textContent = safetyInfo.safetyNumber;
    $('qr-svg-box').innerHTML = window.ConnectNowQR.renderQRToSvg(`cn-verify:${safetyInfo.fingerprintHex}`, 170);
    $('qr-modal').classList.add('active');
  });
  $('close-qr-btn').addEventListener('click', () => $('qr-modal').classList.remove('active'));

  $('join-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const num = $('room-number-input').value.trim();
    if (!/^[0-9]{4,12}$/.test(num)) {
      showToast('Enter a 4–12 digit number', 'error');
      return;
    }
    joinSecretRoom(num);
  });

  $('leave-room-btn').addEventListener('click', () => destroySession(true));
  $('panic-btn').addEventListener('click', () => {
    destroySession(true);
    showToast('Panic Mode: Session destroyed & wiped');
  });

  $('theme-toggle-btn').addEventListener('click', () => {
    const isLight = document.body.classList.toggle('theme-light');
    localStorage.setItem('cn_theme', isLight ? 'light' : 'dark');
  });
  if (localStorage.getItem('cn_theme') === 'light') document.body.classList.add('theme-light');

  $('settings-btn').addEventListener('click', () => {
    $('metered-key-input').value = getMeteredKey();
    $('stealth-toggle').checked = localStorage.getItem('cn_stealth') !== 'false';
    $('settings-modal').classList.add('active');
  });
  $('close-settings-btn').addEventListener('click', () => $('settings-modal').classList.remove('active'));
  $('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    localStorage.setItem('cn_metered_key', $('metered-key-input').value.trim());
    localStorage.setItem('cn_stealth', String($('stealth-toggle').checked));
    updateTurnHint();
    $('settings-modal').classList.remove('active');
    showToast('Settings saved');
  });

  window.addEventListener('beforeunload', () => destroySession(true));
  window.addEventListener('pagehide', () => destroySession(true));

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  updateTurnHint();
})();
