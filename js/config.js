/**
 * ConnectNow Static Configuration
 * Paste your Metered.ca TURN API key below OR set it inside the app's Settings modal.
 * Get a free TURN API key at https://www.metered.ca/tools/openrelay/
 */
window.CONNECTNOW_CONFIG = {
  // Replace with your real Metered API key for 4G/5G cellular NAT traversal:
  METERED_API_KEY: "",

  // Public STUN fallbacks (used automatically if Metered API key is not set)
  STUN_SERVERS: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" }
  ],

  // PeerJS signaling prefix (keep unique to avoid collisions on public PeerServer)
  PEER_PREFIX: "cn-ephemeral-v2-"
};
