"use client";

import { useState, useEffect, useRef } from "react";
import { io } from "socket.io-client";
import { Music2, Users, Mic, MicOff, Copy, Plus, Trash2, Lock } from "lucide-react";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001";

export default function HostDashboard() {
  const socketRef = useRef<any>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [shareGuide, setShareGuide] = useState<null | "preflight" | "noaudio" | "nodevice" | "denied">(null);
  const [guideSurface, setGuideSurface] = useState<string | null>(null);
  const [monitorOn, setMonitorOn] = useState(false);
  const monitorRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode } | null>(null);
  const [level, setLevel] = useState(0);

  // Input level meter so the host can SEE that audio is being captured.
  useEffect(() => {
    const iv = setInterval(() => {
      const a = analyserRef.current;
      if (!a) return;
      const buf = new Uint8Array(a.analyser.frequencyBinCount);
      try {
        a.analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128); if (v > peak) peak = v; }
        setLevel(Math.min(100, Math.round((peak / 128) * 100)));
      } catch {}
    }, 120);
    return () => clearInterval(iv);
  }, []);
  const [roomId, setRoomId] = useState("");
  const [invitationCode, setInvitationCode] = useState("");
  const [streamActive, setStreamActive] = useState(false);
  const [participants, setParticipants] = useState<any[]>([]);
  const [playlist, setPlaylist] = useState<any[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createForm, setCreateForm] = useState({ hostName: "", roomName: "" });
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (m: string) => {
    setToast(m);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  };
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ["websocket", "polling"] });
    socketRef.current = socket;

    socket.on("connect", () => {
      setIsConnected(true);
      setConnError(null);
      setReconnectAttempt(0);
    });
    socket.on("disconnect", () => setIsConnected(false));
    socket.on("connect_error", (err: any) => {
      setIsConnected(false);
      setConnError(err?.message || "Unable to reach the backend server.");
    });
    socket.io.on("reconnect_attempt", (attempt: number) => {
      setReconnectAttempt(attempt);
    });
    socket.io.on("reconnect", () => setConnError(null));
    socket.on("room:created", (data: any) => {
      setRoomId(data.room.roomId);
      setInvitationCode(data.room.invitationCode);
    });
    socket.on("participant:joined", (data: any) => {
      setParticipants((prev) => [...prev, data.participant]);
      // A listener arrived mid-broadcast — build their WebRTC link right away.
      if (audioTrackRef.current) {
        createPeerConnection(data.participant.id, audioTrackRef.current);
      }
    });
    socket.on("participant:left", (data: any) => {
      setParticipants((prev) => prev.filter((p) => p.id !== data.userId));
      const pc = peerConnections.current.get(data.userId);
      if (pc) { pc.close(); peerConnections.current.delete(data.userId); }
    });
    // The listener's answer for our offer — required for the connection to complete.
    socket.on("webrtc:answer", async (data: any) => {
      const pc = peerConnections.current.get(data.from);
      if (pc && pc.signalingState !== "stable") {
        try { await pc.setRemoteDescription(data.sdp); } catch {}
      }
    });
    // Listener's ICE candidates must be fed into their PC, or media never flows.
    socket.on("webrtc:ice-candidate", async (data: any) => {
      const pc = peerConnections.current.get(data.from);
      if (pc && data.candidate) {
        try { await pc.addIceCandidate(data.candidate); } catch {}
      }
    });
    socket.on("host:stream-stopped", () => {
      setStreamActive(false);
      stopLocalStream();
    });
    return () => {
      socket.disconnect();
      stopLocalStream();
      audioTrackRef.current = null;
      peerConnections.current.forEach((pc) => pc.close());
      peerConnections.current.clear();
    };
  }, []);

  const createRoom = () => {
    if (!socketRef.current) return;
    socketRef.current.emit(
      "room:create",
      { name: createForm.roomName.trim() || "VibeSync Listening Room", hostName: createForm.hostName.trim() || "Host", isPrivate: true },
      (result: any) => {
        if (result.error) { showToast(result.error); return; }
        // One UI for everyone: the host uses the same room page as listeners —
        // the stream controls live there now. Copy the invite link from there too.
        const hostName = createForm.hostName.trim() || "Host";
        window.location.href = `/room/${result.roomId}?name=${encodeURIComponent(hostName)}`;
      }
    );
  };

  const beginBroadcast = (stream: MediaStream, audioTrack: MediaStreamTrack, opts?: { autoMonitor?: boolean }) => {
    audioTrack.onended = () => stopStream();
    audioTrackRef.current = audioTrack;
    setLocalStream(stream);
    setIsStreaming(true);
    setStreamActive(true);
    participants.forEach((p) => createPeerConnection(p.id, audioTrack));
    socketRef.current?.emit("host:stream-status", { roomId, active: true });
    // Live input meter
    try {
      if (analyserRef.current) { analyserRef.current.ctx.close().catch(() => {}); analyserRef.current = null; }
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      src.connect(analyser);
      analyserRef.current = { ctx, analyser };
    } catch {}
    if (opts?.autoMonitor) startMonitor(stream);
  };

  const startStream = async () => {
    setShareGuide(null);
    try {
      // video must be requested (Chrome/Brave reject audio-only display capture),
      // but it is never sent to peers — only the audio track is. Keep the video
      // track alive locally (tiny/1fps) instead of stopping it, since stopping it
      // can end the whole capture — audio included — on some Chromium builds.
      const constraints: any = {
        video: { frameRate: { max: 1 }, width: { max: 320 }, height: { max: 240 } },
        audio: { suppressLocalAudioPlayback: false },
        // Keep the audio checkboxes on offer in all Chromium browsers:
        systemAudio: "include",
        selfBrowserSurface: "include",
        surfaceSwitching: "include",
      };
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        // Figure out exactly what was shared so the guide can be specific:
        const surface: string | undefined = stream.getVideoTracks()[0]?.getSettings?.().displaySurface;
        setGuideSurface(surface || "unknown");
        stream.getTracks().forEach((t) => t.stop());
        setShareGuide("noaudio");
        return;
      }
      beginBroadcast(stream, audioTrack);
    } catch (err: any) {
      if (err?.name === "NotAllowedError") return; // user closed the picker
      showToast("Failed to capture tab audio: " + (err?.message || String(err)));
    }
  };

  // Most reliable path — no picker at all. Captures a Windows loopback input
  // (Stereo Mix / VB-CABLE "CABLE Output") that carries everything the PC plays,
  // including the Spotify desktop app and any browser.
  const startDeviceCapture = async () => {
    try {
      // A one-off mic permission grant is required to read device labels.
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const loopback = devices.find(
        (d) => d.kind === "audioinput" && /cable|loopback|stereo\s*mix|senheiser|what\s*u\s*hear/i.test(d.label)
      );
      if (!loopback) {
        setShareGuide("nodevice");
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: loopback.deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      const track = stream.getAudioTracks()[0];
      setShareGuide(null);
      beginBroadcast(stream, track, { autoMonitor: true });
    } catch (err: any) {
      if (err?.name === "NotAllowedError") {
        setShareGuide("denied");
        return;
      }
      showToast("Audio device capture failed: " + (err?.message || String(err)));
    }
  };

  // Hear your own broadcast locally (the loopback/device route is silent otherwise).
  const startMonitor = (stream: MediaStream) => {
    if (monitorRef.current) return;
    try {
      const ctx = new AudioContext();
      monitorRef.current = ctx;
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = 1;
      src.connect(gain);
      gain.connect(ctx.destination);
      setMonitorOn(true);
    } catch {}
  };

  const stopMonitor = () => {
    if (monitorRef.current) {
      monitorRef.current.close().catch(() => {});
      monitorRef.current = null;
      setMonitorOn(false);
    }
  };

  const toggleMonitor = () => {
    if (monitorRef.current) { stopMonitor(); return; }
    if (localStream) startMonitor(localStream);
  };

  const stopStream = () => {
    setIsStreaming(false);
    setStreamActive(false);
    stopLocalStream();
    socketRef.current?.emit("host:stream-status", { roomId, active: false });
  };

  const stopLocalStream = () => {
    localStream?.getTracks().forEach((track) => track.stop());
    setLocalStream(null);
    audioTrackRef.current = null;
    stopMonitor();
    if (analyserRef.current) {
      analyserRef.current.ctx.close().catch(() => {});
      analyserRef.current = null;
      setLevel(0);
    }
    if (monitorRef.current) {
      monitorRef.current.close().catch(() => {});
      monitorRef.current = null;
      setMonitorOn(false);
    }
  };

  const createPeerConnection = (userId: string, audioTrack: MediaStreamTrack) => {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.addTrack(audioTrack);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit("webrtc:ice-candidate", { to: userId, candidate: event.candidate });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        pc.close();
        peerConnections.current.delete(userId);
      }
    };
    peerConnections.current.set(userId, pc);
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
      socketRef.current?.emit("webrtc:offer", { to: userId, sdp: pc.localDescription });
    });
  };

  const copyInviteLink = async () => {
    if (!roomId) return;
    const link = `${window.location.origin}/room/${roomId}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast("Invite link copied!");
    } catch {
      showToast("Clipboard unavailable — copy the room link from your browser.");
    }
  };

  const removeParticipant = (userId: string) => {
    if (confirm("Remove this participant?")) {
      socketRef.current?.emit("room:leave", { roomId, userId });
    }
  };

  if (!isConnected) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#0a0a0a] px-4">
        <div className="glass-panel p-8 rounded-2xl text-center max-w-md w-full">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4 ${connError ? "bg-red-500/20" : "bg-vs-accent/20"}`}>
            <Music2 className={`w-6 h-6 ${connError ? "text-red-400" : "text-vs-accent"}`} />
          </div>
          {connError ? (
            <>
              <h2 className="text-xl font-bold mb-2">Can't reach the server</h2>
              <p className="text-gray-400 text-sm mb-1">Socket URL: <code className="text-gray-300">{SOCKET_URL}</code></p>
              <p className="text-gray-500 text-sm mb-6">{connError} Make sure the backend is running (npm run dev) and try again.</p>
              <button
                onClick={() => {
                  setConnError(null);
                  socketRef.current?.connect();
                }}
                className="px-6 py-3 min-h-[44px] w-full bg-vs-accent hover:bg-vs-accentHover active:bg-vs-accentHover rounded-full text-sm font-semibold transition-all"
              >
                Retry
              </button>
            </>
          ) : (
            <>
              <h2 className="text-xl font-bold mb-2">Connecting to server...</h2>
              <p className="text-gray-400">Please wait while we establish connection.{reconnectAttempt > 0 ? ` (attempt ${reconnectAttempt + 1})` : ""}</p>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="host-shell h-dvh flex flex-col overflow-hidden bg-[#0a0a0a] text-white">
      {shareGuide && (
        <div className="fixed inset-0 z-[60] bg-black/80 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShareGuide(null)}>
          <div className="bg-[#141414] border border-white/10 rounded-t-2xl sm:rounded-2xl p-5 sm:p-8 max-w-lg w-full max-h-[92dvh] overflow-y-auto no-scrollbar relative pb-safe" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShareGuide(null)} aria-label="Close" className="absolute top-4 right-4 p-2 -m-1 text-gray-400 hover:text-white transition-colors leading-none">✕</button>
            <div className="sm:hidden w-10 h-1 bg-white/20 rounded-full mx-auto mb-4 mt-1"></div>
            {(() => {
              const headline =
                shareGuide === "denied"
                  ? "Microphone access was blocked"
                  : shareGuide === "nodevice"
                    ? "No loopback input found on this PC"
                    : shareGuide === "noaudio"
                      ? "That source had no audio"
                      : "How to broadcast your music";
              const whyMissing =
                guideSurface === "window"
                  ? "You picked a window or desktop app — Windows never carries audio for window captures, no matter the browser."
                  : guideSurface === "monitor"
                    ? "You shared Entire Screen without ticking “Also share system audio” — the screen came through silent."
                    : guideSurface === "browser"
                      ? "You shared a tab without its audio — the “Also share tab audio” checkbox wasn't ticked (or your Brave build hides it)."
                      : null;
              return (
                <>
                  <h3 className="text-xl font-bold mb-2">{headline}</h3>
                  <p className="text-sm text-gray-400 mb-4">
                    {shareGuide === "denied"
                      ? "Brave/Windows blocked access to your audio input. Allow microphone access for this site, then retry."
                      : shareGuide === "nodevice"
                        ? "VibeSync looks for a loopback input (Stereo Mix or VB-CABLE) that mirrors everything your PC plays. None matched — set one up using the quick one-time steps in Option C below."
                        : shareGuide === "noaudio"
                          ? whyMissing || "The source you picked came through without an audio track."
                          : "Three ways to broadcast — the two-tick tab route, system audio, or the bulletproof loopback that doesn't rely on the picker at all:"}
                  </p>
                </>
              );
            })()}
            <div className="space-y-3 mb-5">
              <div className="glass-panel p-4 rounded-xl">
                <p className="font-semibold text-sm mb-1.5 text-vs-accent">Option A — Share the browser tab</p>
                <ol className="text-xs text-gray-400 space-y-1 list-decimal list-inside">
                  <li>In the picker, choose <b className="text-gray-200">Chrome Tab</b> (this label appears in Brave too).</li>
                  <li>Pick the tab playing your music — YouTube, or Spotify's <b className="text-gray-200">web player</b> (open.spotify.com).</li>
                  <li>Tick <b className="text-gray-200">Also share tab audio</b>, then Share.</li>
                </ol>
                <p className="text-xs text-gray-500 mt-2">Spotify's desktop app is a window — it can't be captured this way. Use Option B or C for the app.</p>
              </div>
              <div className="glass-panel p-4 rounded-xl">
                <p className="font-semibold text-sm mb-1.5 text-vs-accent">Option B — Share PC sound (Entire Screen)</p>
                <ol className="text-xs text-gray-400 space-y-1 list-decimal list-inside">
                  <li>In the picker, choose <b className="text-gray-200">Entire Screen</b>.</li>
                  <li>Tick <b className="text-gray-200">Also share system audio</b>.</li>
                  <li>Share — everything your PC plays is broadcast, including the Spotify app.</li>
                </ol>
                <p className="text-xs text-gray-500 mt-2">No checkbox? Update Brave (brave://settings/help) — it needs a recent Chromium.</p>
              </div>
              <div className="glass-panel p-4 rounded-xl border border-vs-accent/30">
                <p className="font-semibold text-sm mb-1.5 text-vs-accent">Option C — Loopback input (bulletproof, no picker)</p>
                <ol className="text-xs text-gray-400 space-y-1 list-decimal list-inside">
                  <li>One-time setup — either enable your sound card's <b className="text-gray-200">Stereo Mix</b> (Sound settings → Recording devices, right-click → Enable), or install the free <b className="text-gray-200">VB-CABLE</b>.</li>
                  <li>With VB-CABLE: Windows Settings → Sound → Volume mixer → set the <b className="text-gray-200">Spotify app</b>'s output to <b className="text-gray-200">CABLE Input</b> (for Stereo Mix, skip — it mirrors your speakers).</li>
                  <li>Click <b className="text-gray-200">Capture PC audio with a loopback device</b> below — no share dialog appears.</li>
                </ol>
                <p className="text-xs text-gray-500 mt-2">You won't hear the audio yourself while capturing — use the Monitor button after going live.</p>
              </div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <button onClick={startStream} className="min-h-[48px] py-3 gradient-bg active:opacity-90 rounded-xl text-sm font-bold flex items-center justify-center gap-2">
                <Mic className="w-4 h-4" /> {shareGuide === "denied" ? "Retry permission" : "Open share dialog"}
              </button>
              <button onClick={startDeviceCapture} className="min-h-[48px] py-3 bg-white/5 border border-vs-accent/40 hover:bg-vs-accent/10 active:bg-vs-accent/10 rounded-xl text-sm font-semibold flex items-center justify-center gap-2">
                <Music2 className="w-4 h-4" /> Capture PC audio with a loopback device
              </button>
            </div>
            <a
              href="https://vb-audio.com/Cable/"
              target="_blank"
              rel="noreferrer"
              className="block text-xs text-gray-500 hover:text-vs-accent transition-colors text-center mt-3"
            >
              VB-CABLE download →
            </a>
          </div>
        </div>
      )}
      <nav className="host-header glass-panel border-b border-white/5 px-4 sm:px-8 h-16 shrink-0 flex items-center justify-between z-50">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 gradient-bg rounded flex items-center justify-center">
            <Music2 className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-lg sm:text-xl tracking-tight gradient-text">VibeSync</span>
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          <span className={`text-xs sm:text-sm font-medium ${streamActive ? "text-vs-accent" : "text-gray-400"}`}>
            {streamActive ? "● LIVE" : "OFFLINE"}
          </span>
          {streamActive && (
            <button onClick={stopStream} className="px-4 py-2.5 min-h-[40px] border border-red-500/30 text-red-400 rounded hover:bg-red-500/10 active:bg-red-500/10 transition-all text-sm">
              Stop Stream
            </button>
          )}
        </div>
      </nav>
      <main className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-y-auto lg:overflow-hidden">
        <aside className="lg:w-1/4 lg:shrink-0 border-b lg:border-b-0 lg:border-r border-white/5 bg-[#141414]/50 p-4 sm:p-6 lg:overflow-y-auto">
          <div className="space-y-4 sm:space-y-6">
            <div className="glass-panel p-4 sm:p-5 rounded-xl">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Room Information</h3>
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-vs-accent/20 rounded flex items-center justify-center shrink-0">
                    <Users className="w-4 h-4 text-vs-accent" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium break-all">{roomId || "—"}</p>
                    <p className="text-xs text-gray-500">Room ID</p>
                  </div>
                </div>
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 bg-vs-accent/20 rounded flex items-center justify-center shrink-0">
                    <Copy className="w-4 h-4 text-vs-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{invitationCode ? `${window.location.origin}/room/${roomId}` : "—"}</p>
                    <p className="text-xs text-gray-500">Invitation Link</p>
                  </div>
                  <button onClick={copyInviteLink} disabled={!roomId} aria-label="Copy invite link" title={roomId ? "Copy invite link" : "Create a room to copy an invite link"} className="p-2.5 min-w-[40px] min-h-[40px] -m-1 text-gray-400 hover:text-vs-accent active:text-vs-accent disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center">
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>

            <div className="glass-panel p-4 sm:p-5 rounded-xl">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Stream Controls</h3>
              {!roomId && !showCreateForm && (
                <button onClick={() => setShowCreateForm(true)} className="w-full min-h-[52px] py-4 gradient-bg active:opacity-90 rounded-xl text-sm font-bold flex items-center justify-center gap-2 shadow-lg shadow-purple-500/30">
                  <Plus className="w-4 h-4" /> Create Room
                </button>
              )}
              {!roomId && showCreateForm && (
                <div className="space-y-3">
                  <div>
                    <label htmlFor="host-name" className="block text-xs font-medium text-gray-400 mb-1.5">Your host name</label>
                    <input
                      id="host-name"
                      type="text"
                      autoComplete="nickname"
                      value={createForm.hostName}
                      onChange={(e) => setCreateForm({ ...createForm, hostName: e.target.value })}
                      placeholder="Host"
                      className="w-full px-3 py-2.5 bg-[#0a0a0a] border border-white/10 rounded-lg text-white text-sm focus:border-vs-accent"
                    />
                  </div>
                  <div>
                    <label htmlFor="room-name" className="block text-xs font-medium text-gray-400 mb-1.5">Room name</label>
                    <input
                      id="room-name"
                      type="text"
                      value={createForm.roomName}
                      onChange={(e) => setCreateForm({ ...createForm, roomName: e.target.value })}
                      placeholder="VibeSync Listening Room"
                      className="w-full px-3 py-2.5 bg-[#0a0a0a] border border-white/10 rounded-lg text-white text-sm focus:border-vs-accent"
                    />
                  </div>
                  <div className="flex items-center gap-2.5 text-sm text-gray-300 py-1 bg-white/5 border border-white/10 rounded-lg px-3">
                    <Lock className="w-4 h-4 text-vs-accent shrink-0" />
                    <span>Private room — only people with your invite link can join</span>
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button onClick={createRoom} className="flex-1 min-h-[48px] py-3 gradient-bg active:opacity-90 rounded-xl text-sm font-bold shadow-lg shadow-purple-500/30">
                      Create
                    </button>
                    <button onClick={() => setShowCreateForm(false)} className="px-4 min-h-[48px] border border-white/10 rounded-xl text-sm text-gray-400 active:bg-white/5 transition-all">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {roomId && (
                <>
                  <button
                    onClick={() => setShareGuide("preflight")}
                    disabled={isStreaming}
                    className={`w-full py-4 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all ${isStreaming ? "bg-gray-800 text-gray-500 cursor-not-allowed" : "gradient-bg shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50"}`}
                  >
                    {isStreaming ? (
                      <>
                        <MicOff className="w-5 h-5" /> Streaming Active
                      </>
                    ) : (
                      <>
                        <Mic className="w-5 h-5" /> Share Tab Audio
                      </>
                    )}
                  </button>
                  {streamActive && (
                    <div className="mt-3 space-y-2">
                      <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
                        <div className="flex items-center gap-2">
                          <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></div>
                          <span className="text-xs text-green-400 font-medium">Broadcasting to {participants.length} listener(s)</span>
                        </div>
                      </div>
                      <div className="pt-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wider text-gray-500 shrink-0">Input</span>
                          <div className="flex-1 h-2 bg-gray-800 rounded-full overflow-hidden">
                            <div className="h-full bg-green-500 rounded-full transition-all duration-150" style={{ width: `${level}%` }} />
                          </div>
                          <span className="text-[10px] text-gray-500 w-8 text-right">{level}%</span>
                        </div>
                        {level === 0 && (
                          <p className="text-[10px] text-yellow-500/80 mt-1">No audio detected — is your music playing / device set up?</p>
                        )}
                      </div>
                      <button
                        onClick={toggleMonitor}
                        className={`w-full py-2 px-3 rounded-lg text-xs font-medium border transition-all flex items-center justify-center gap-2 ${monitorOn ? "bg-vs-accent/20 border-vs-accent/40 text-vs-accent" : "bg-white/5 border-white/10 text-gray-400 hover:text-white hover:border-white/25"}`}
                      >
                        <Music2 className="w-3 h-3" /> {monitorOn ? "Monitoring — you hear the broadcast" : "Monitor (hear what listeners hear)"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="glass-panel p-4 sm:p-5 rounded-xl">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">Connected Listeners</h3>
              <div className="space-y-3">
                {participants.map((p) => (
                  <div key={p.id} className="flex items-center gap-3 p-3 rounded-lg bg-white/5">
                    <div className="w-8 h-8 rounded-full bg-vs-accent/20 flex items-center justify-center text-vs-accent text-xs font-bold shrink-0">
                      {p.name.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{p.name}</p>
                      <p className="text-xs text-gray-500">{p.role}</p>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className={`w-2 h-2 rounded-full ${p.isOnline ? "bg-green-500" : "bg-gray-500"}`}></span>
                    </div>
                    <button onClick={() => removeParticipant(p.id)} aria-label="Remove participant" className="text-gray-500 hover:text-red-500 active:text-red-500 transition-colors p-2 min-w-[36px] min-h-[36px] -m-1 flex items-center justify-center">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {participants.length === 0 && (
                  <p className="text-xs text-gray-500 text-center py-4">No listeners yet. Share the link above.</p>
                )}
              </div>
            </div>
          </div>
        </aside>
        <section className="flex-1 bg-[#0a0a0a] p-4 sm:p-8 lg:overflow-y-auto">
          <h2 className="text-xl sm:text-2xl font-bold mb-4 sm:mb-6">Shared Playlist</h2>
          {/* Mobile: stacked cards. Desktop: table. */}
          <div className="xl:hidden glass-panel rounded-xl divide-y divide-white/5 border border-white/5">
            {playlist.map((track: any, idx: number) => (
              <div key={track.id} className="flex items-center gap-3 p-3">
                <span className="text-xs text-gray-500 w-5 text-right shrink-0">{idx + 1}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{track.title}</p>
                  <p className="text-xs text-gray-500 truncate">{track.artist}{track.addedByName ? ` • ${track.addedByName}` : ""}</p>
                </div>
                <button onClick={() => socketRef.current?.emit("playlist:remove", { roomId, trackId: track.id })} aria-label="Remove track" className="text-red-400 active:text-red-300 transition-colors p-2 min-w-[36px] min-h-[36px] -m-1 flex items-center justify-center shrink-0">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
            {playlist.length === 0 && (
              <p className="px-4 py-10 text-center text-sm text-gray-500">No tracks in queue yet.</p>
            )}
          </div>
          <div className="hidden xl:block glass-panel rounded-xl overflow-x-auto border border-white/5">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-white/5">
                  <th className="px-6 py-4 text-xs font-medium text-gray-400 uppercase">#</th>
                  <th className="px-6 py-4 text-xs font-medium text-gray-400 uppercase">Track</th>
                  <th className="px-6 py-4 text-xs font-medium text-gray-400 uppercase">Artist</th>
                  <th className="px-6 py-4 text-xs font-medium text-gray-400 uppercase">Added By</th>
                  <th className="px-6 py-4 text-xs font-medium text-gray-400 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {playlist.map((track: any, idx: number) => (
                  <tr key={track.id} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="px-6 py-4 text-sm text-gray-400">{idx + 1}</td>
                    <td className="px-6 py-4 text-sm">{track.title}</td>
                    <td className="px-6 py-4 text-sm text-gray-400">{track.artist}</td>
                    <td className="px-6 py-4 text-sm text-gray-400">{track.addedByName}</td>
                    <td className="px-6 py-4">
                      <button onClick={() => socketRef.current?.emit("playlist:remove", { roomId, trackId: track.id })} aria-label="Remove track" className="text-red-400 hover:text-red-300 transition-colors p-2 -m-1 flex items-center justify-center">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))}
                {playlist.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center text-gray-500">
                      No tracks in queue yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      {toast && (
        <div role="status" aria-live="polite" className="fixed top-20 left-1/2 -translate-x-1/2 z-[70] glass-panel px-4 py-2 text-sm rounded-full shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}