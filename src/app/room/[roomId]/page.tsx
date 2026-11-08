"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { io } from "socket.io-client";
import { useRouter, usePathname } from "next/navigation";
import { useSearchParams } from "next/navigation";
import { Music2, Users, Mic, Play, Pause, SkipForward, SkipBack, Volume2, VolumeX, MessageCircle, Smile, Send, Copy, Trash2, X, Lock, Search, TrendingUp, History, Clock, ExternalLink, Heart, Zap, ListMusic, ArrowLeft } from "lucide-react";

// Participants arrive in several shapes across the wire: [id, p] pairs from the
// server serializer, flat objects from join broadcasts, plain objects from old
// snapshots. Flatten once here and keep it that way everywhere in the UI.
function normalizeParticipants(raw: any): any[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  return arr
    .map((p: any) => (Array.isArray(p) ? p[1] : p))
    .filter((p: any) => p && typeof p === "object" && p.id);
}

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001";

export default function ListeningRoom() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const roomId = pathname.split("/").pop() || "";
  const userName = searchParams.get("name") || "Guest";

  const socketRef = useRef<any>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);        // WebRTC host stream
  const playlistAudioRef = useRef<HTMLAudioElement | null>(null); // direct audioUrl tracks
  const ytRef = useRef<{ player: any; ready: boolean }>({ player: null, ready: false });
  const ytCbsRef = useRef<Array<(p: any) => void>>([]);
  const ytLoadingRef = useRef(false);
  const trackRef = useRef<any>(null);
  const isPlayingRef = useRef(false);
  const isHostRef = useRef(false);

  const [isConnected, setIsConnected] = useState(false);
  const [connError, setConnError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [room, setRoom] = useState<any>(null);
  const [participant, setParticipant] = useState<any>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTrack, setCurrentTrack] = useState<any>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [durations, setDurations] = useState<Record<string, number>>({});
  const [volume, setVolume] = useState(100);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [peerConnection, setPeerConnection] = useState<RTCPeerConnection | null>(null);
  const [ytError, setYtError] = useState<string | null>(null);
  const [audioUnlocked, setAudioUnlocked] = useState(false);
  // ---- host streaming: the host captures THIS tab's audio and pipes it to listeners ----
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamLevel, setStreamLevel] = useState(0);
  const [chatInput, setChatInput] = useState("");
  const [showChat, setShowChat] = useState(true);
  const [searchQ, setSearchQ] = useState("");
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    if (typeof window !== 'undefined') {
      try {
        const saved = localStorage.getItem('vibesync_recent_searches');
        return saved ? JSON.parse(saved) : [];
      } catch { return []; }
    }
    return [];
  });
  const [savedQueues, setSavedQueues] = useState<Record<string, { name: string; savedAt: string; playlist: any[] }>>({});
  const [socketEpoch, setSocketEpoch] = useState(0); // bumped by the watchdog to force a fresh socket
  const gotAckRef = useRef(false);
  const fallbackTriedRef = useRef(false);
  const seenChatIdsRef = useRef<Set<string>>(new Set());

  // ---- mobile-first navigation ---------------------------------------------
  // Mobile has a full Player tab and a docked mini-player on Chat/Queue.
  // Desktop retains the two-column layout.
  const [mobilePanel, setMobilePanel] = useState<"player" | "queue" | "chat">(() => {
    // Search page nav links come back with ?panel= — land on that tab directly.
    const p = searchParams.get("panel");
    return p === "chat" || p === "queue" || p === "player" ? p : "player";
  });
  const [unreadChat, setUnreadChat] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = (m: string) => {
    setToast(m);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  };
  const totalChat = room?.chatMessages?.length || 0;
  const lastSeenChatRef = useRef(0);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  // New message (or opening the chat tab) → snap the conversation to the newest line
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [totalChat, mobilePanel, showChat]);
  useEffect(() => {
    if (mobilePanel === "chat") {
      lastSeenChatRef.current = totalChat;
      setUnreadChat(0);
    } else {
      setUnreadChat(Math.max(0, totalChat - lastSeenChatRef.current));
    }
  }, [mobilePanel, totalChat]);

  // ---- Search lives on its own page (/room/:id/search) ----------------------
  const openSearchPage = () => {
    const q = searchQ.trim() ? `&q=${encodeURIComponent(searchQ.trim())}` : "";
    router.push(`/room/${roomId}/search?name=${encodeURIComponent(userName)}${q}`);
  };

  // One-tap picks that prefill + run the search instantly
  const QUICK_PICKS = [
    "Arijit Singh top songs",
    "AP Dhillon hits",
    "Diljit Dosanjh hits",
    "Bollywood hits 2026",
    "Punjabi top hits 2026",
    "AR Rahman hits",
    "Shreya Ghoshal songs",
    "Tamil hit songs",
    "Telugu hit songs",
    "Lo-fi beats for study",
    "Workout motivation songs",
    "Rainy day vibes",
  ];

  // Quick picks are visible whenever the Queue search is idle; trending cards
  // are shown once the user focuses the search field.
  const TRENDING_SUGGESTIONS = [
    { query: "Arijit Singh top songs", title: "Arijit Singh", subtitle: "Soulful hits & new releases", icon: Heart },
    { query: "AP Dhillon hits", title: "AP Dhillon", subtitle: "Punjabi chart-toppers", icon: Zap },
    { query: "Diljit Dosanjh hits", title: "Diljit Dosanjh", subtitle: "Bhangra & romantic anthems", icon: Music2 },
    { query: "Bollywood hits 2026", title: "Bollywood 2026", subtitle: "Latest Hindi chartbusters", icon: TrendingUp },
    { query: "Punjabi top hits 2026", title: "Punjabi 2026", subtitle: "Fresh drops & classics", icon: Zap },
    { query: "AR Rahman hits", title: "A.R. Rahman", subtitle: "Timeless masterpieces", icon: Heart },
    { query: "Shreya Ghoshal songs", title: "Shreya Ghoshal", subtitle: "Melodious female vocals", icon: Music2 },
    { query: "Tamil hit songs", title: "Tamil Hits", subtitle: "Kollywood trending", icon: TrendingUp },
    { query: "Telugu hit songs", title: "Telugu Hits", subtitle: "Tollywood trending", icon: Zap },
    { query: "Lo-fi beats for study", title: "Lo-fi Study", subtitle: "Chill beats to focus", icon: Music2 },
    { query: "Workout motivation songs", title: "Workout Mix", subtitle: "High energy gym tracks", icon: Zap },
    { query: "Rainy day vibes", title: "Rainy Day", subtitle: "Cozy mood setters", icon: Heart },
  ];

  // ---- localStorage queue persistence (host drives it in this browser) ----
  const SAVED_KEY = "vibesync:saved-queues";
  useEffect(() => {
    try {
      setSavedQueues(JSON.parse(localStorage.getItem(SAVED_KEY) || "{}"));
    } catch {}
  }, []);

  useEffect(() => {
    if (!isHost || !roomId || !room) return;
    try {
      const saved = JSON.parse(localStorage.getItem(SAVED_KEY) || "{}");
      saved[roomId] = {
        name: room?.name || "VibeSync Room",
        savedAt: new Date().toISOString(),
        playlist: room.playlist || [],
      };
      localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
      setSavedQueues(saved);
    } catch {}
  }, [isHost, roomId, room?.name, room?.playlist?.length]);

  const loadSavedQueue = (key: string) => {
    const s = savedQueues[key];
    if (!s?.playlist?.length || !socketRef.current) return;
    s.playlist.forEach((t: any) => socketRef.current.emit("playlist:add", { roomId, track: t }));
  };

  useEffect(() => { trackRef.current = currentTrack; }, [currentTrack]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);

  // ---- shared playback helpers -------------------------------------------
  const trackDuration = useCallback((t: any) => {
    if (!t) return 0;
    const d = durations[t.id] || durations[t.youtubeId];
    return d && d > 0 ? d : t.duration || 0;
  }, [durations]);

  const applySeek = useCallback((t: number) => {
    const track = trackRef.current;
    try {
      if (track?.youtubeId && ytRef.current.ready) ytRef.current.player.seekTo(t, true);
      else if (track?.audioUrl && playlistAudioRef.current) playlistAudioRef.current.currentTime = t;
    } catch {}
  }, []);

  const stopLocalPlayers = useCallback(() => {
    try { if (ytRef.current.ready) ytRef.current.player.pauseVideo(); } catch {}
    playlistAudioRef.current?.pause();
  }, []);

  const applyPlayback = useCallback((track: any, playing: boolean, time: number = 0) => {
    setCurrentTrack(track);
    setIsPlaying(playing);
    trackRef.current = track;
    isPlayingRef.current = playing;
    if (typeof time === "number" && time > 0) setCurrentTime(floorHalf(time));
    if (!playing && !track) setCurrentTime(0); // queue ended
    if (playing) {
      if (track?.youtubeId) {
        getOrLoadYT((p) => {
          try {
            const cur = p.getVideoData?.().video_id;
            if (cur !== track.youtubeId) p.loadVideoById(track.youtubeId, Math.floor(time || 0));
            else p.seekTo(Math.floor(time || 0), true);
            p.playVideo();
          } catch {}
        });
      } else if (track?.audioUrl) {
        const el = playlistAudioRef.current;
        if (el) {
          if (el.src !== track.audioUrl) el.src = track.audioUrl;
          el.currentTime = time || 0;
          el.play().catch(() => {});
        }
      } else {
        stopLocalPlayers();
      }
    } else {
      stopLocalPlayers();
    }
  }, [stopLocalPlayers]);

  // ---- host streaming refs -------------------------------------------------
  const isStreamingRef = useRef(false);
  useEffect(() => { isStreamingRef.current = isStreaming; }, [isStreaming]);
  const hostTrackRef = useRef<MediaStreamTrack | null>(null);
  const hostStreamRef = useRef<MediaStream | null>(null);
  const hostPCsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const hostAnalyserRef = useRef<{ ctx: AudioContext; analyser: AnalyserNode } | null>(null);
  // live input level meter so the host can SEE audio is flowing
  useEffect(() => {
    const iv = setInterval(() => {
      const a = hostAnalyserRef.current;
      if (!a) return;
      try {
        const buf = new Uint8Array(a.analyser.frequencyBinCount);
        a.analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i] - 128); if (v > peak) peak = v; }
        setStreamLevel(Math.min(100, Math.round((peak / 128) * 100)));
      } catch {}
    }, 150);
    return () => clearInterval(iv);
  }, []);

  // Unlock audio on first user interaction (click/tap/key) — browsers block autoplay until then
  useEffect(() => {
    const unlock = () => {
      setAudioUnlocked(true);
      // also try to resume any pending playback
      if (isPlayingRef.current && trackRef.current?.youtubeId) {
        getOrLoadYT((p) => { try { p.playVideo(); } catch {} });
      }
    };
    window.addEventListener("click", unlock, { once: true });
    window.addEventListener("keydown", unlock, { once: true });
    window.addEventListener("touchstart", unlock, { once: true, passive: true });
    return () => {
      window.removeEventListener("click", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
  }, []);

  // ---- Auto DJ: keep the radio going from the room's listening taste -------
  const autoDjBusyRef = useRef(false);
  const runAutoDj = async (endedTrackId?: string) => {
    if (autoDjBusyRef.current || !socketRef.current) return;
    // only kick in when the room is actually idle-ish
    if (!endedTrackId && isPlayingRef.current) return;
    autoDjBusyRef.current = true;
    try {
      const res = await fetch(`${SOCKET_URL}/autoDj`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId, ...(endedTrackId ? { endedTrackId } : {}) }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.track) {
        console.log("[vibesync] Auto DJ added:", data.track.title);
        // everyone already got the add broadcast — one client pins playback.
        // Sending the track object too means this tab can start even if its
        // own playlist update hasn't landed yet (no race, no silence).
        socketRef.current.emit("playback:play", { roomId, trackId: data.track.id, timestamp: 0, track: data.track });
      }
    } catch {
      // radio is best-effort
    } finally {
      setTimeout(() => {
        autoDjBusyRef.current = false;
      }, 3000);
    }
  };

  // Track ended on the local player: advance to the next queued track, or let
  // the Auto DJ pick one from the room's listening taste. Safe to fire on
  // every tab — the server's lock collapses concurrent picks into one add.
  const onTrackEnded = () => {
    const list = roomRef.current?.playlist || [];
    const cur = trackRef.current;
    const idx = cur ? list.findIndex((t: any) => t.id === cur.id) : -1;
    const next = idx >= 0 ? list[idx + 1] : null;
    if (next && socketRef.current) {
      socketRef.current.emit("playback:play", { roomId, trackId: next.id, timestamp: 0 });
    } else if (!next) {
      runAutoDj(cur?.id);
    }
  };

  const getOrLoadYT = useCallback((cb: (p: any) => void) => {
    if (ytRef.current.ready) { cb(ytRef.current.player); return; }
    ytCbsRef.current.push(cb);
    if (ytLoadingRef.current) return;
    ytLoadingRef.current = true;
    const w = window as any;
    const create = () => {
      const host = document.getElementById("yt-player-host");
      if (!host) { setTimeout(create, 200); return; }
      if (w.__vsYtActive) { return; }
      w.__vsYtActive = true;
      ytRef.current.player = new w.YT.Player("yt-player-host", {
        height: "1", width: "1",
        playerVars: { autoplay: 1, controls: 0, playsinline: 1, rel: 0, iv_load_policy: 3 },
        events: {
          onReady: () => {
            ytRef.current.ready = true;
            ytCbsRef.current.forEach((c) => c(ytRef.current.player));
            ytCbsRef.current = [];
          },
          onStateChange: (e: any) => {
            if (e.data === w.YT.PlayerState.PLAYING) {
              try {
                const id = ytRef.current.player.getVideoData().video_id;
                const dur = ytRef.current.player.getDuration();
                if (id && dur) setDurations((d) => ({ ...d, [id]: dur }));
              } catch {}
            }
            if (e.data === w.YT.PlayerState.ENDED) {
              try { onTrackEnded(); } catch {}
            }
          },
          onError: () => {
            setYtError("YouTube refused this video for embedding — try another track.");
            setTimeout(() => setYtError(null), 8000);
          },
        },
      });
    };
    if (w.YT?.Player) { create(); return; }
    if (!w.__vsYtRequested) {
      w.__vsYtRequested = true;
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      document.head.appendChild(s);
    }
    const iv = setInterval(() => {
      if (w.YT?.Player) { clearInterval(iv); create(); }
    }, 250);
  }, []);

  // ---- socket wiring -------------------------------------------------------
  useEffect(() => {
    if (!roomId) return;

    console.log("[vibesync] room effect start:", roomId, "as", userName, "epoch", socketEpoch);

    // HTTP fallback: if the socket system is wedged, restore room state over REST.
    if (socketEpoch >= 2 && !fallbackTriedRef.current) {
      fallbackTriedRef.current = true;
      console.log("[vibesync] trying HTTP room fallback");
      fetch(`${SOCKET_URL}/room/${roomId}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status))))
        .then((data) => {
          setRoom(data);
          setParticipant({ id: "self", name: userName, role: "participant", isOnline: true });
          setIsConnected(true);
          console.log("[vibesync] HTTP fallback: room restored");
        })
        .catch((e) => console.log("[vibesync] HTTP fallback failed:", e.message));
    }

    const socket = io(SOCKET_URL, {
      transports: ["websocket", "polling"],
      forceNew: true, // dev HMR/StrictMode can hand back a corrupted cached manager
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 2000,
      timeout: 8000,
    });
    socketRef.current = socket;

    socket.on("connect", () => {
      console.log("[vibesync] socket connected:", socket.id);
      setIsConnected(true); setConnError(null);
    });
    socket.on("disconnect", () => setIsConnected(false));
    socket.on("connect_error", (err: any) => {
      setIsConnected(false);
      setConnError(err?.message || "Unable to reach the backend server.");
    });

    // Watchdog: if the socket hasn't connected (or the join ack hasn't landed)
    // within a few seconds, throw it away and remount with a brand-new one.
    const watchdog = setTimeout(() => {
      if (!socket.connected || !gotAckRef.current) {
        if (socketEpoch >= 3) return; // let the HTTP fallback handle it
        console.log("[vibesync] watchdog: socket stalled, recreating (epoch", socketEpoch, "→", socketEpoch + 1, ")");
        socket.disconnect();
        setSocketEpoch((n) => n + 1);
      }
    }, 5000);

    // NOTE: every room mutation below guards against a null room — the room
    // state stays null until the room:join callback lands.
    // The server answers a join over the ack callback (it never emits a
    // "room:join" event), so room state is set here — not in an event listener.
    socket.emit("room:join", { roomId, name: userName }, (result: any) => {
      gotAckRef.current = true;
      console.log("[vibesync] join ack:", result?.error ? ("ERROR " + result.error) : ("ok room=" + result?.room?.id + " participants=" + (result?.room?.participants?.length || 0)));
      if (result.error) {
        setJoinError(result.error);
        return;
      }
      setRoom({ ...result.room, participants: normalizeParticipants(result.room?.participants) });
      setParticipant(result.participant);
      setIsHost(result.participant?.role === "host");
      if (result.room?.playbackState?.trackId) {
        const track = result.room.playlist.find((t: any) => t.id === result.room.playbackState.trackId);
        if (track) {
          applyPlayback(track, result.room.playbackState.isPlaying, result.room.playbackState.currentTime || 0);
        } else if (result.room.playbackState.isPlaying && result.room.playlist?.length) {
          // The room was playing a track that has since been removed — someone
          // should keep the party going, so play the next queued track (or Auto
          // DJ's recommendation when the queue ran dry).
          const next = result.room.playlist[0];
          console.log("[vibesync] stale playbackState track — advancing to", next?.title);
          socketRef.current.emit("playback:play", { roomId, trackId: next.id, timestamp: 0 });
        } else {
          applyPlayback(null, false, 0);
        }
      }
    });

    socket.on("playlist:track-added", (data: any) => {
      setRoom((prev: any) => prev ? { ...prev, playlist: [...(prev.playlist || []), data.track] } : prev);
    });

    socket.on("playlist:updated", (data: any) => {
      setRoom((prev: any) => prev ? { ...prev, playlist: data.playlist || [] } : prev);
    });

    socket.on("playlist:track-removed", (data: any) => {
      setRoom((prev: any) => prev ? { ...prev, playlist: (prev.playlist || []).filter((t: any) => t.id !== data.trackId) } : prev);
    });

    socket.on("playback:play", (data: any) => {
      const track = roomRef.current?.playlist?.find((t: any) => t.id === data.trackId) || data.track || null;
      applyPlayback(track, true, data.timestamp || 0);
    });

    socket.on("playback:pause", (data: any) => {
      applyPlayback(trackRef.current, false, data?.timestamp || 0);
    });

    socket.on("playback:skip", (data: any) => {
      if (!data.trackId) {
        applyPlayback(null, false, 0);
        // Queue drained — Auto DJ keeps the music going
        runAutoDj();
        return;
      }
      const roomRefNow = roomRef.current;
      const track = roomRefNow?.playlist?.find((t: any) => t.id === data.trackId) || null;
      applyPlayback(track, true, data.timestamp || 0);
    });

    socket.on("playback:seek", (data: any) => {
      setCurrentTime(data.timestamp || 0);
      applySeek(data.timestamp || 0);
    });

    socket.on("participant:joined", (data: any) => {
      const p = Array.isArray(data?.participant) ? data.participant[1] : data?.participant;
      setRoom((prev: any) => prev ? {
        ...prev,
        participants: [...(prev.participants || []).filter((x: any) => x.id !== p?.id), p].filter(Boolean),
        // client-side ephemeral system line — lives only in this tab, never persisted
        chatMessages: p?.name ? [...(prev.chatMessages || []), {
          id: `sys-${Date.now()}-${p.id}`, userId: "__system__", userName: p.name,
          message: "", timestamp: new Date().toISOString(), isSystem: true,
        }] : (prev.chatMessages || []),
      } : prev);
      // a listener arrived while we're live — build their WebRTC link right away
      if (isStreamingRef.current && p?.id && p.id !== socketRef.current?.id) createHostPC(p.id);
    });

    socket.on("participant:left", (data: any) => {
      setRoom((prev: any) => prev ? { ...prev, participants: (prev.participants || []).filter((p: any) => p.id !== data.userId) } : prev);
      const hpc = hostPCsRef.current.get(data.userId);
      if (hpc) { hpc.close(); hostPCsRef.current.delete(data.userId); }
    });

    socket.on("chat:message-added", (data: any) => {
      const m = data.message;
      const id = m?.id;
      if (id && seenChatIdsRef.current.has(id)) return; // already appended optimistically
      // the sender appended optimistically on send — the server echo would
      // duplicate it, so consume the pending marker instead of adding again
      const pendKey = "pending:" + (m?.message || "");
      if (m?.userId === socketRef.current?.id && seenChatIdsRef.current.has(pendKey)) {
        seenChatIdsRef.current.delete(pendKey); // consume: a later identical text must still show
        if (id) seenChatIdsRef.current.add(id);
        return;
      }
      if (id) seenChatIdsRef.current.add(id);
      setRoom((prev: any) => prev ? { ...prev, chatMessages: [...(prev.chatMessages || []), data.message] } : prev);
    });

    socket.on("host:stream-stopped", () => {
      if (remoteStream) {
        remoteStream.getTracks().forEach((t) => t.stop());
        setRemoteStream(null);
      }
      if (peerConnection) {
        peerConnection.close();
        setPeerConnection(null);
      }
    });

    socket.on("webrtc:offer", async (data: any) => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
      setPeerConnection(pc);

      pc.onicecandidate = (event) => {
        if (event.candidate) socket.emit("webrtc:ice-candidate", { to: data.from, candidate: event.candidate });
      };

      pc.ontrack = (event) => {
        setRemoteStream(event.streams[0]);
        if (audioRef.current) {
          audioRef.current.srcObject = event.streams[0];
          audioRef.current.play().catch(() => {});
        }
      };

      await pc.setRemoteDescription(data.sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("webrtc:answer", { to: data.from, sdp: answer });
    });

    socket.on("webrtc:answer", async (data: any) => {
      // host side: an answer from a listener we offered to
      const hostPC = hostPCsRef.current.get(data.from);
      if (hostPC && hostPC.signalingState !== "stable") {
        try { await hostPC.setRemoteDescription(data.sdp); } catch {}
        return;
      }
      // listener side: the host's answer to our offer
      if (peerConnection) {
        await peerConnection.setRemoteDescription(data.sdp);
      }
    });

    socket.on("webrtc:ice-candidate", async (data: any) => {
      const hostPC = data.from ? hostPCsRef.current.get(data.from) : null;
      if (hostPC && data.candidate) {
        try { await hostPC.addIceCandidate(data.candidate); } catch {}
        return;
      }
      if (peerConnection && data.candidate) await peerConnection.addIceCandidate(data.candidate).catch(() => {});
    });

    socket.on("host:stream-status", (data: any) => {
      setRoom((prev: any) => prev ? { ...prev, streamActive: !!data.active } : prev);
    });

    return () => {
      clearTimeout(watchdog);
      socket.emit("room:leave", { roomId, userId: socket.id });
      socket.disconnect();
      if (peerConnection) peerConnection.close();
      // host streaming teardown (navigating away ends the broadcast)
      if (isStreamingRef.current) {
        try { socket.emit("host:stream-status", { roomId, active: false }); } catch {}
      }
      hostStreamRef.current?.getTracks().forEach((t: any) => t.stop());
      hostStreamRef.current = null;
      hostTrackRef.current = null;
      hostPCsRef.current.forEach((pc) => pc.close());
      hostPCsRef.current.clear();
      if (hostAnalyserRef.current) { hostAnalyserRef.current.ctx.close().catch(() => {}); hostAnalyserRef.current = null; }
      try { ytRef.current.player?.destroy?.(); } catch {}
      ytRef.current = { player: null, ready: false };
      ytLoadingRef.current = false;
      const w = window as any;
      w.__vsYtActive = false;
    };
  }, [roomId, userName, socketEpoch]);

  // ---- host drift correction: heartbeat the wall-clock position -----------
  useEffect(() => {
    if (!isHost || !isPlaying) return;
    const iv = setInterval(() => {
      const t = currentTimeRef.current;
      if (t > 0) socketRef.current?.emit("playback:seek", { roomId, timestamp: Math.floor(t) });
    }, 10000);
    return () => clearInterval(iv);
  }, [isHost, isPlaying, roomId]);

  useEffect(() => { roomRef.current = room; }, [room]);
  const roomRef = useRef<any>(null);
  const currentTimeRef = useRef(0);
  useEffect(() => { currentTimeRef.current = currentTime; }, [currentTime]);

  // ---- Auto DJ idle-start: fresh room, empty queue, nobody playing ---------
  // Gives listeners a few seconds to add their first track — otherwise the
  // radio starts from seeds (Indian-first) and learns taste from there.
  const idleKickRef = useRef(false);
  useEffect(() => {
    if (!isConnected || idleKickRef.current) return;
    if (room && (room.playlist || []).length === 0 && !isPlaying && !currentTrack) {
      idleKickRef.current = true;
      console.log("[vibesync] idle room — Auto DJ kick in 5s");
      const t = setTimeout(() => { runAutoDj(); }, 5000);
      return () => clearTimeout(t);
    }
  }, [isConnected, room?.playlist?.length, isPlaying, currentTrack?.id, roomId]);

  // ---- local clock: advance time from the actual players when possible ----
  useEffect(() => {
    const iv = setInterval(() => {
      if (!isPlayingRef.current) return;
      let t: number | null = null;
      const track = trackRef.current;
      if (track?.youtubeId && ytRef.current.ready) {
        try { t = ytRef.current.player.getCurrentTime(); } catch {}
        // self-heal the duration map: the PLAYING event can fire before the
        // length is known (getDuration()=0) and never re-fires — keep sampling
        try {
          const vid = ytRef.current.player.getVideoData?.().video_id;
          const dur = ytRef.current.player.getDuration?.();
          if (vid && dur) setDurations((d) => (d[vid] === dur ? d : { ...d, [vid]: dur }));
        } catch {}
      } else if (track?.audioUrl && playlistAudioRef.current) {
        t = playlistAudioRef.current.currentTime;
      }
      setCurrentTime((prev) => (t != null && !isNaN(t) ? floorHalf(t) : prev + 0.5));
    }, 500);
    return () => clearInterval(iv);
  }, []);

  // ---- controlled elements' volume ----------------------------------------
  useEffect(() => {
    const v = Math.min(1, Math.max(0, volume / 100));
    if (playlistAudioRef.current) playlistAudioRef.current.volume = v;
    try { ytRef.current.player?.setVolume?.(Math.round(v * 100)); } catch {}
  }, [volume]);

  // ---- user actions --------------------------------------------------------
  const togglePlay = () => {
    if (!socketRef.current) return;
    setAudioUnlocked(true); // user explicitly clicked play → unlock
    // Nothing loaded? Act like Spotify's radio: start the first queued track,
    // or ask Auto DJ to pick a recommended track when the queue is empty.
    if (!currentTrack) {
      const list = room?.playlist || [];
      if (list.length) playTrackNow(list[0].id);
      else runAutoDj();
      return;
    }
    if (isPlaying) socketRef.current.emit("playback:pause", { roomId, timestamp: currentTime });
    else socketRef.current.emit("playback:play", { roomId, trackId: currentTrack?.id || "", timestamp: currentTime });
  };

  const skipTrack = () => {
    if (!socketRef.current) return;
    // No track loaded (idle room) → Next still works: the recommendation
    // engine picks based on the room's listening history.
    if (!currentTrack) {
      runAutoDj();
      return;
    }
    // No vote system — anyone can skip straight to the next track.
    socketRef.current.emit("playback:skip", { roomId, trackId: currentTrack.id });
  };

  const playTrackNow = (trackId: string) => {
    socketRef.current?.emit("playback:play", { roomId, trackId, timestamp: 0 });
  };

  const playPreviousTrack = () => {
    const playlist = room?.playlist || [];
    const currentIndex = playlist.findIndex((track: any) => track.id === currentTrack?.id);
    if (currentIndex > 0) {
      playTrackNow(playlist[currentIndex - 1].id);
      return;
    }
    if (currentTrack) {
      setCurrentTime(0);
      socketRef.current?.emit("playback:seek", { roomId, timestamp: 0 });
    }
  };

  // ---- host streaming: capture this tab's audio → WebRTC to each listener ---
  const createHostPC = (listenerId: string) => {
    const track = hostTrackRef.current;
    if (!track || !socketRef.current) return;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
    pc.addTrack(track);
    pc.onicecandidate = (event) => {
      if (event.candidate) socketRef.current?.emit("webrtc:ice-candidate", { to: listenerId, candidate: event.candidate });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        pc.close();
        hostPCsRef.current.delete(listenerId);
      }
    };
    hostPCsRef.current.set(listenerId, pc);
    pc.createOffer().then((offer) => pc.setLocalDescription(offer)).then(() => {
      socketRef.current?.emit("webrtc:offer", { to: listenerId, sdp: pc.localDescription });
    }).catch(() => {});
  };

  const stopHostStream = () => {
    hostStreamRef.current?.getTracks().forEach((t: any) => t.stop());
    hostStreamRef.current = null;
    hostTrackRef.current = null;
    setIsStreaming(false);
    hostPCsRef.current.forEach((pc) => pc.close());
    hostPCsRef.current.clear();
    if (hostAnalyserRef.current) { hostAnalyserRef.current.ctx.close().catch(() => {}); hostAnalyserRef.current = null; }
    setStreamLevel(0);
    socketRef.current?.emit("host:stream-status", { roomId, active: false });
  };

  const startHostStream = async () => {
    try {
      // video must be requested (Chromium rejects audio-only display capture);
      // only the audio track is ever sent — pick "This tab" + tick tab audio
      const constraints: any = {
        video: { frameRate: { max: 1 }, width: { max: 320 }, height: { max: 240 } },
        audio: { suppressLocalAudioPlayback: false },
        systemAudio: "include",
        selfBrowserSurface: "include",
        surfaceSwitching: "include",
      };
      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
      const audioTrack = stream.getAudioTracks()[0];
      if (!audioTrack) {
        stream.getTracks().forEach((t: any) => t.stop());
        showToast('Pick "This tab" and tick "Also share tab audio" so listeners hear the music');
        return;
      }
      audioTrack.onended = () => stopHostStream();
      hostStreamRef.current = stream;
      hostTrackRef.current = audioTrack;
      setIsStreaming(true);
      // wire every listener that is already in the room
      const members = normalizeParticipants(roomRef.current?.participants);
      members.forEach((m: any) => {
        if (m.id !== socketRef.current?.id) createHostPC(m.id);
      });
      socketRef.current?.emit("host:stream-status", { roomId, active: true });
      // live input meter
      try {
        if (hostAnalyserRef.current) { hostAnalyserRef.current.ctx.close().catch(() => {}); hostAnalyserRef.current = null; }
        const ctx = new AudioContext();
        const src = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        hostAnalyserRef.current = { ctx, analyser };
      } catch {}
      showToast("Live! Listeners can hear your tab now 🔴");
    } catch (err: any) {
      if (err?.name === "NotAllowedError") return; // user closed the picker
      showToast("Failed to capture tab audio: " + (err?.message || String(err)));
    }
  };

  const removeTrack = (trackId: string) => {
    socketRef.current?.emit("playlist:remove", { roomId, trackId });
  };

  const sendChat = (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim() || !socketRef.current || !room) return;
    // Optimistic append: the message shows instantly even if the socket echo
    // is swallowed; the chat:message-added handler dedupes by id.
    const msg = {
      id: `self-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      userId: socketRef.current.id || "self",
      userName,
      message: chatInput.trim(),
      timestamp: new Date(),
      reactions: {},
    };
    seenChatIdsRef.current.add("pending:" + msg.message);
    seenChatIdsRef.current.add(msg.id);
    setRoom((prev: any) => prev ? { ...prev, chatMessages: [...(prev.chatMessages || []), msg] } : prev);
    socketRef.current.emit("chat:message", { roomId, message: chatInput, userName, userId: socketRef.current.id });
    setChatInput("");
  };

  const formatTime = (seconds: number) => {
    if (!seconds || isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${pathname}`);
      showToast("Invite link copied!");
    } catch {
      showToast("Clipboard unavailable — copy the room link from your browser.");
    }
  };

  const duration = currentTrack ? trackDuration(currentTrack) : 0;

  const retryConnection = () => {
    setConnError(null);
    setJoinError(null);
    socketRef.current?.connect();
  };

  // ---- screens -------------------------------------------------------------
  if (connError) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#0a0a0a] px-4">
        <div className="glass-panel p-8 rounded-2xl text-center max-w-md w-full">
          <h2 className="text-xl font-bold mb-2">Can't reach the server</h2>
          <p className="text-gray-400 text-sm mb-6">{connError} Start the backend (npm run dev) and try again.</p>
          <button onClick={retryConnection} className="px-6 py-3 min-h-[44px] bg-vs-accent hover:bg-vs-accentHover active:bg-vs-accentHover rounded-full text-sm font-semibold w-full sm:w-auto">Retry</button>
        </div>
      </div>
    );
  }

  if (joinError) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#0a0a0a] px-4">
        <div className="glass-panel p-8 rounded-2xl text-center max-w-md w-full">
          <h2 className="text-xl font-bold mb-2">Room not found</h2>
          <p className="text-gray-400 text-sm mb-6">{joinError}. Room codes live only while the server is running and the host's room exists.</p>
          <button onClick={() => router.push("/")} className="px-6 py-3 min-h-[44px] bg-vs-accent hover:bg-vs-accentHover active:bg-vs-accentHover rounded-full text-sm font-semibold w-full sm:w-auto">Back home</button>
        </div>
      </div>
    );
  }

  if (!isConnected || !room) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#0a0a0a] px-4">
        <div className="glass-panel p-8 rounded-2xl text-center">
          <div className="w-12 h-12 bg-vs-accent/20 rounded-full flex items-center justify-center mx-auto mb-4">
            <Music2 className="w-6 h-6 text-vs-accent" />
          </div>
          <h2 className="text-xl font-bold mb-2">Joining room...</h2>
          <p className="text-gray-400">Connecting to the listening session.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="room-shell h-dvh flex flex-col overflow-hidden bg-[#0a0a0a] text-white">
      <nav className="room-header glass-panel border-b border-white/5 px-3 sm:px-6 h-14 lg:h-16 shrink-0 flex items-center justify-between z-50">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <div className="w-8 h-8 bg-vs-accent/20 rounded-lg flex items-center justify-center shrink-0">
            <Music2 className="w-5 h-5 text-vs-accent" />
          </div>
          <span className="font-bold text-base sm:text-lg tracking-tight gradient-text">VibeSync</span>
          {roomId && <span className="hidden sm:block text-xs text-gray-500 ml-1 truncate max-w-32">Room: {roomId}</span>}
        </div>
        <div className="flex items-center gap-1 sm:gap-3">
          <span className="flex items-center gap-1 text-[11px] sm:text-xs text-gray-400 shrink-0" title="Private room — only invited-link holders can join">
            <Lock className="w-3.5 h-3.5 text-vs-accent" />
            <span className="hidden md:inline">Private</span>
          </span>
          <span className="hidden sm:flex text-sm text-gray-400 items-center gap-1.5">
            <Users className="w-4 h-4" /> {room.participants?.length || 1}
          </span>
          <button onClick={copyInvite} className="p-2.5 min-w-[44px] min-h-[44px] flex items-center justify-center text-gray-400 hover:text-vs-accent active:text-vs-accent transition-colors" title="Copy invite link" aria-label="Copy invite link">
            <Copy className="w-4 h-4" />
          </button>
          <div aria-label={isConnected ? "Connected to room" : "Disconnected from room"} role="status" className={`w-2 h-2 rounded-full shrink-0 ${isConnected ? "bg-green-500" : "bg-red-500"}`}></div>
          <button onClick={() => router.push("/")} className="px-2.5 sm:px-4 py-2 min-h-[36px] border border-white/10 rounded-lg text-xs sm:text-sm hover:bg-white/5 active:bg-white/5 transition-all">
            Leave
          </button>
        </div>
      </nav>

      <main className="room-main flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden" data-active-panel={mobilePanel}>
        {/* Mobile gets a full Player tab and a Spotify-style dock on Chat/Queue; desktop keeps the original split layout. */}
        <div className={`mobile-player-pane ${mobilePanel === "player" ? "mobile-player-pane--full order-1 flex-1" : "mobile-player-pane--mini order-2 flex-none"} flex min-w-0 min-h-0 overflow-hidden flex-col p-1 sm:p-2 lg:order-none lg:h-auto lg:flex-1 lg:overflow-y-auto lg:p-8`}>
          {/* Host stream control — same room UI as listeners, plus this bar */}
          {isHost && (
            <div className="mini-host-bar glass-panel rounded-lg lg:rounded-xl p-1.5 lg:p-3 mb-1 lg:mb-4 flex items-center gap-2 lg:gap-3 shrink-0">
              <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${isStreaming ? "bg-red-500 animate-pulse" : "bg-gray-600"}`} />
              {isStreaming ? (
                <span className="text-[10px] lg:text-sm flex-1 min-w-0 truncate">Live — listeners are hearing your tab audio</span>
              ) : (
                <span className="text-[10px] lg:text-sm text-gray-400 flex-1 min-w-0 truncate">Listeners hear silence until you start</span>
              )}
              {isStreaming && (
                <div className="w-14 lg:w-20 h-1.5 rounded-full bg-gray-800 overflow-hidden shrink-0" title="Your audio input level">
                  <div className="h-full bg-gradient-to-r from-emerald-400 to-vs-accent transition-all duration-150" style={{ width: `${streamLevel}%` }} />
                </div>
              )}
              <button
                onClick={isStreaming ? stopHostStream : startHostStream}
                title={isStreaming ? "Stop sharing this tab's audio" : 'Share this tab\'s audio — pick "This tab" and tick "Also share tab audio"'}
                className={`px-2.5 lg:px-4 py-1.5 lg:py-2 min-h-[36px] lg:min-h-[44px] rounded-full text-[10px] lg:text-sm font-bold shrink-0 transition-all ${isStreaming ? "bg-red-500/20 border border-red-500/40 text-red-300 active:bg-red-500/30" : "gradient-bg shadow-lg shadow-purple-500/30"}`}
              >
                {isStreaming ? "Stop Stream" : "Start Stream"}
              </button>
            </div>
          )}
          <div
            className={`mini-player-card glass-panel rounded-xl lg:rounded-2xl p-1 lg:p-8 mb-0 lg:mb-8 relative overflow-hidden w-full sm:max-w-lg lg:max-w-none mx-auto flex flex-col flex-1 min-h-0 lg:flex-none ${mobilePanel !== "player" ? "cursor-pointer" : ""}`}
            onClick={(event) => {
              if (mobilePanel === "player" || window.matchMedia("(min-width: 1024px)").matches) return;
              const target = event.target;
              if (target instanceof Element && target.closest("button, input, a")) return;
              setMobilePanel("player");
            }}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-vs-accent/10 to-transparent pointer-events-none"></div>
            <div className="mini-player-content relative z-10 h-full min-h-0 flex flex-col justify-center">
              <div className="mini-track-heading flex items-center gap-2 mb-1 lg:flex-col lg:justify-center lg:gap-0 lg:mb-6 relative shrink-0">
                <div className="mini-track-art vinyl-disc w-11 h-11 lg:w-72 lg:h-72 rounded-full overflow-hidden relative shrink-0">
                  {/* Spinning vinyl body: sheen + grooves + artwork label. The spin
                      freezes (animation-play-state: paused) when playback stops
                      instead of snapping back to the start. */}
                  <div
                    className="absolute inset-0 animate-[spin_8s_linear_infinite]"
                    style={{ animationPlayState: isPlaying ? "running" : "paused" }}
                  >
                    <div className="vinyl-sheen absolute inset-0 rounded-full" />
                    <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[44%] h-[44%] rounded-full overflow-hidden vinyl-label flex items-center justify-center">
                      {currentTrack?.artworkUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img key={currentTrack.id} src={currentTrack.artworkUrl} alt="Album Art" className="w-full h-full object-cover" />
                      ) : (
                        <Music2 className="w-2.5 h-2.5 lg:w-9 lg:h-9 text-vs-accent/60" />
                      )}
                      <span className="vinyl-hole absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full w-[7%] h-[7%] min-w-[3px] min-h-[3px]" />
                    </div>
                  </div>
                  <div className="vinyl-grooves absolute inset-0 rounded-full pointer-events-none" />
                  {room?.streamActive && (
                    <span className="absolute top-2 left-2 z-10 text-[10px] font-bold bg-red-600/90 text-white px-2 py-0.5 rounded-full flex items-center gap-1.5 shadow-lg backdrop-blur-sm">
                      <span className="w-1.5 h-1.5 bg-white rounded-full animate-pulse" /> LIVE
                    </span>
                  )}
                  {isPlaying && <div className="absolute inset-0 w-full h-full rounded-full border border-vs-accent/40 animate-ping shadow-[0_0_30px_rgba(139,92,246,0.35)]" /> }
                  {isPlaying && !audioUnlocked && (
                    <button
                      aria-label="Tap to enable sound"
                      onClick={() => {
                        setAudioUnlocked(true);
                        applyPlayback(currentTrack, true, currentTime);
                        if (currentTrack?.audioUrl) playlistAudioRef.current?.play().catch(() => {});
                      }}
                      className="absolute inset-0 z-20 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center gap-2 animate-fade-in rounded-full"
                    >
                      <Play className="w-5 h-5 lg:w-10 lg:h-10 text-white" />
                      <span className="hidden lg:inline text-xs text-gray-300">Tap to enable sound</span>
                    </button>
                  )}
                </div>
                <div className="min-w-0 flex-1 text-left lg:flex-none lg:text-center">
                  <div className="mobile-now-playing hidden lg:flex items-center justify-center gap-2 lg:gap-3 mb-2">
                    <span className="px-2 py-0.5 rounded bg-vs-accent/10 text-vs-accent text-xs sm:text-sm font-medium border border-vs-accent/20 animate-pulse-slow">
                      LIVE
                    </span>
                    <span className="text-xs lg:text-sm font-medium text-vs-accent/80 uppercase tracking-wider">
                      Now Playing
                    </span>
                  </div>
                  {(() => {
                    // Long titles scroll like a retro ticker; short ones stay put
                    const titleText = currentTrack?.title || "No track playing";
                    const scroll = currentTrack?.title?.length > 30;
                    return (
                      <h1 className={`mobile-track-title text-sm lg:text-4xl font-bold text-white mb-0 lg:mb-3 leading-tight overflow-hidden whitespace-nowrap ${scroll ? "marquee-edge" : ""}`}>
                        <span
                          className={scroll ? "marquee-scroll" : "block truncate w-full"}
                          style={scroll ? { animationPlayState: isPlaying ? "running" : "paused" } : undefined}
                        >
                          <span>{titleText}</span>
                          {scroll && <span aria-hidden="true">{titleText}</span>}
                        </span>
                      </h1>
                    );
                  })()}
                  <p className="mobile-track-artist text-xs lg:text-3xl text-vs-accent font-medium mb-0 lg:mb-2 truncate">{currentTrack?.artist || "—"}</p>
                  {currentTrack?.source === "youtube" && (
                    <p className="hidden lg:block text-xs text-gray-500 text-center mb-3 lg:mb-6">YouTube embed • synced by the room</p>
                  )}
                  {!currentTrack?.source && (
                    <p className="hidden lg:flex text-sm text-gray-400 mb-8 lg:mb-10 items-center justify-center gap-1.5">
                      <span className="w-1 h-1 rounded-full bg-gray-500" />
                      Added by {currentTrack?.addedByName || "Unknown"}
                    </p>
                  )}
                </div>
                {mobilePanel !== "player" && (
                  <button
                    type="button"
                    onClick={() => setMobilePanel("player")}
                    aria-label="Open full player"
                    title="Open full player"
                    className="lg:hidden shrink-0 w-9 h-9 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-gray-300 hover:text-white hover:bg-white/10 transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" aria-hidden="true" />
                  </button>
                )}
              </div>

              {ytError && <p className="mini-player-hide text-[10px] lg:text-xs text-red-400 text-center mb-1 lg:mb-3">{ytError}</p>}

              <div className="mini-player-hide flex items-center justify-between px-1 lg:px-4 mb-1 lg:mb-2 text-[10px] lg:text-sm text-gray-400">
                <span>{formatTime(currentTime)}</span>
                <span>{formatTime(duration)}</span>
              </div>

              {/* Thick progress bar */}
              <div className="mobile-mini-progress mini-player-hide w-full h-1.5 lg:h-2 bg-gray-800 rounded-full relative group mb-2 lg:mb-10 focus-within:ring-2 focus-within:ring-vs-accent/70">
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, duration)}
                  step={1}
                  value={Math.max(0, Math.min(currentTime, duration || 0))}
                  aria-label="Playback position"
                  aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
                  disabled={!currentTrack || !duration}
                  onChange={(e) => setCurrentTime(Number(e.currentTarget.value))}
                  onPointerUp={(e) => socketRef.current?.emit("playback:seek", { roomId, timestamp: Number(e.currentTarget.value) })}
                  onKeyUp={(e) => socketRef.current?.emit("playback:seek", { roomId, timestamp: Number(e.currentTarget.value) })}
                  className="absolute inset-x-0 -top-2 z-10 h-6 w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed"
                />
                <div
                  className="h-full gradient-bg rounded-full transition-all duration-100"
                  style={{ width: duration ? `${Math.min(100, (currentTime / duration) * 100)}%` : "0%" }}
                />
                <div className="absolute -top-2 -right-0 w-5 h-5 bg-vs-accent rounded-full shadow-[0_0_15px_rgba(139,92,246,0.6)] pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity transform scale-0 group-hover:scale-100" />
              </div>


              <div className="mini-player-controls flex items-center justify-center gap-3 lg:gap-8 shrink-0">
                <button
                  onClick={playPreviousTrack}
                  disabled={!currentTrack}
                  aria-label="Play previous track"
                  className="mini-control-button w-11 h-11 lg:w-16 lg:h-16 rounded-full bg-vs-accent/10 border border-vs-accent/20 flex items-center justify-center hover:bg-vs-accent/20 hover:border-vs-accent/30 hover:text-vs-accent transition-all active:scale-90 disabled:opacity-30 disabled:cursor-not-allowed group"
                >
                  <SkipBack className="w-6 h-6 text-vs-accent group-hover:text-vs-accent" />
                </button>
                <button
                  onClick={togglePlay}
                  aria-label={isPlaying ? "Pause playback" : "Start playback"}
                  className="mini-play-button w-12 h-12 lg:w-24 lg:h-24 rounded-full gradient-bg flex items-center justify-center shadow-2xl shadow-vs-accent/50 hover:shadow-vs-accent/70 hover:-translate-y-1 transition-all active:scale-95 group"
                >
                  {isPlaying ? (
                    <Pause className="w-6 h-6 lg:w-9 lg:h-9 text-white" />
                  ) : (
                    <Play className="w-6 h-6 lg:w-9 lg:h-9 text-white ml-1" />
                  )}
                </button>
                <button
                  onClick={skipTrack}
                  aria-label="Skip track"
                  className="mini-control-button w-11 h-11 lg:w-16 lg:h-16 rounded-full bg-vs-accent/10 border border-vs-accent/20 flex items-center justify-center hover:bg-vs-accent/20 hover:border-vs-accent/30 hover:text-vs-accent transition-all active:scale-90 group"
                >
                  <SkipForward className="w-6 h-6 text-vs-accent group-hover:text-vs-accent" />
                </button>
              </div>

              {/* Full Player tab exposes volume on mobile; the compact dock stays volume-free. */}
              <div className="mobile-volume-control hidden lg:block w-full max-w-[340px] mx-auto mt-2 lg:mt-12">
                <div className="flex items-center justify-between text-[10px] lg:text-sm text-gray-400 mb-0.5 lg:mb-2">
                  <span className="flex items-center gap-1">
                    <Volume2 className="w-3 h-3 text-vs-accent/50" />
                    Volume
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={volume}
                  onChange={(e) => setVolume(Number(e.currentTarget.value))}
                  aria-label="Playback volume"
                  className="w-full h-4 lg:h-5 accent-[#8b5cf6] cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-vs-accent/70 rounded"
                />
              </div>
              {remoteStream && (
                <p className="mini-player-hide text-[10px] lg:text-xs text-green-400 text-center mt-1 lg:mt-4">● Host audio stream connected</p>
              )}
            </div>
          </div>
        </div>

        {/* Chat and Queue become full-height mobile tabs while the mini player docks below them. */}
        <div className={`room-panels ${mobilePanel === "player" ? "hidden" : "flex"} order-1 flex-1 min-h-0 overflow-hidden lg:order-none lg:flex lg:w-1/2 lg:flex-none border-t lg:border-t-0 lg:border-l border-white/5 bg-[#0a0a0a]/30 flex-col`}>
          <section className={`queue-panel ${mobilePanel === "queue" ? "flex" : "hidden"} lg:flex flex-col flex-1 min-h-0 overflow-y-auto no-scrollbar p-4 sm:p-6`}>
          {/* Search is a REAL page now (/room/:id/search) — this field just
              navigates there, preserving whatever the user had typed. */}
          <div className="sticky top-0 z-20 -mx-4 sm:-mx-6 -mt-4 sm:-mt-6 px-4 sm:px-6 pt-3 sm:pt-5 pb-2.5 bg-[#0a0a0a]/95 backdrop-blur-md border-b border-white/5 space-y-2.5 mb-3">
            <div className="flex gap-2">
              <button
                type="button"
                onClick={openSearchPage}
                aria-label="Search songs"
                className="relative flex-1 flex items-center min-h-[44px] px-10 bg-[#0a0a0a] border border-white/10 rounded-xl text-gray-500 hover:text-gray-300 hover:border-vs-accent/40 text-sm text-left transition-colors"
              >
                <Search className="absolute left-3 w-5 h-5 text-gray-500 pointer-events-none" />
                <span className="truncate">{searchQ || "Search songs — Hindi, Punjabi, Tamil, English…"}</span>
              </button>
              <button
                type="button"
                onClick={openSearchPage}
                aria-label="Open search page"
                className="px-4 py-2.5 gradient-bg rounded-xl text-sm font-bold shrink-0 min-h-[44px] min-w-[80px]"
              >
                Search
              </button>
            </div>
          </div>
          <div className="flex items-center justify-between mb-4 sm:mb-6 gap-2">
            <h2 className="text-lg sm:text-xl font-bold truncate">Queue ({room?.playlist?.length || 0})</h2>
            <span className={`text-xs font-medium px-2 py-1 rounded-full shrink-0 ${isHost ? "bg-vs-accent/20 text-vs-accent" : "bg-gray-800 text-gray-500"}`}>
              {isHost ? "Host" : "Listener"}
            </span>
          </div>

          {/* Members — everyone who joined via the invite link */}
          {(() => {
            const members = normalizeParticipants(room?.participants);
            if (!members.length) return null;
            return (
              <div className="flex flex-wrap gap-1.5 mb-4 sm:mb-5" title="People in this room">
                {members.map((m: any) => (
                  <span key={m.id} className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-xs ${m.role === "host" ? "bg-vs-accent/10 border-vs-accent/30 text-white" : "bg-white/5 border-white/10 text-gray-300"}`}>
                    <span className={`w-[18px] h-[18px] rounded-full flex items-center justify-center text-[9px] font-bold shrink-0 ${m.role === "host" ? "gradient-bg text-white" : "bg-vs-accent/20 text-vs-accent"}`}>
                      {(m.name || "?").charAt(0).toUpperCase()}
                    </span>
                    <span className="truncate max-w-[120px]">{m.name}</span>
                    {m.role === "host" && <span title="Host">👑</span>}
                    {participant?.id === m.id && <span className="text-gray-500">(you)</span>}
                  </span>
                ))}
              </div>
            );
          })()}

          <div className="room-queue-list glass-panel rounded-xl p-2 mb-4 sm:mb-6 max-h-none overflow-visible no-scrollbar lg:max-h-[340px] lg:overflow-y-auto">
            {room?.playlist?.map((track: any, idx: number) => {
              const active = currentTrack?.id === track.id;
              return (
                <div key={`q-${track.id}-${idx}`} className={`flex items-center gap-3 p-2 rounded-lg transition-colors group hover:bg-white/5 ${active ? "bg-vs-accent/10 border border-vs-accent/20" : ""}`}>
                  <div className="w-10 h-10 rounded-full overflow-hidden shrink-0 border border-white/5">
                    {track.artworkUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={track.artworkUrl}
                        alt="Art"
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          // old playlists saved hotlink-blocked yt3 avatars — fall back to the video thumb
                          const el = e.currentTarget;
                          const fb = track.youtubeId ? `https://i.ytimg.com/vi/${track.youtubeId}/hqdefault.jpg` : "";
                          if (fb && el.src !== fb) { el.src = fb; } else { el.style.visibility = "hidden"; }
                        }}
                      />
                    ) : (
                      <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                        <Music2 className="w-4 h-4 text-gray-600" />
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{track.title}</p>
                    <p className="text-xs text-gray-500 truncate">
                      {track.artist}{track.source === "youtube" ? " • YouTube" : ""} • {track.addedByName}
                    </p>
                  </div>
                  <button onClick={() => playTrackNow(track.id)} title="Play now" aria-label="Play now" className="p-2 -m-1 min-w-[36px] min-h-[36px] flex items-center justify-center text-gray-400 hover:text-vs-accent active:text-vs-accent transition-colors">
                    <Play className="w-4 h-4" />
                  </button>
                  {/* Row actions stay tappable on touch — opacity only kicks in on hover-capable screens */}
                  <button onClick={() => removeTrack(track.id)} title="Remove from queue" aria-label="Remove from queue" className="p-2 -m-1 min-w-[36px] min-h-[36px] flex items-center justify-center text-gray-500 hover:text-red-400 active:text-red-400 transition-colors md:opacity-0 md:group-hover:opacity-100">
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <span className="hidden md:block text-xs text-gray-500 shrink-0">{formatTime(trackDuration(track))}</span>
                </div>
              );
            })}
            {(room?.playlist?.length || 0) === 0 && (
              <p className="text-gray-500 text-center py-8 text-sm">Queue is empty. Add a YouTube link or a track below!</p>
            )}
          </div>

          {/* Track adding is search-only — link/manual forms removed to keep the queue clean */}

          {isHost && (room?.playlist?.length || 0) === 0 && Object.keys(savedQueues).length > 0 && (
            <div className="mb-6">
              <h3 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-2">Saved queues (this browser)</h3>
              <p className="text-xs text-gray-500 mb-2">Playlists auto-save here while you host — reload a fresh room and pick one up instantly.</p>
              <div className="space-y-2">
                {Object.entries(savedQueues).map(([key, s]) => (
                  <div key={key} className="glass-panel p-3 rounded-xl flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{s.name}</p>
                      <p className="text-xs text-gray-500">{(s.playlist || []).length} tracks • {new Date(s.savedAt).toLocaleString()}</p>
                    </div>
                    <button onClick={() => loadSavedQueue(key)} className="px-4 py-2 bg-vs-accent/20 border border-vs-accent/30 rounded-lg text-xs font-semibold text-vs-accent shrink-0 hover:bg-vs-accent/30 transition-colors">Load</button>
                  </div>
                ))}
              </div>
            </div>
          )}

          </section>

          {/* Chat pane — full-screen tab on mobile, collapsible panel on desktop */}
          <section className={`chat-panel ${mobilePanel === "chat" ? "flex" : "hidden"} lg:flex flex-col flex-1 min-h-0`}>
            {showChat ? (
              <div className="glass-panel rounded-none sm:rounded-xl lg:rounded-xl flex flex-col flex-1 min-h-0 lg:flex-none lg:h-[380px] border-x-0 sm:border-x">
                <div className="p-4 border-b border-white/5 flex items-center justify-between shrink-0">
                  <h3 className="text-sm font-semibold text-gray-300">Room Chat</h3>
                  <button onClick={() => setShowChat(false)} aria-label="Close chat" className="hidden lg:block text-gray-500 hover:text-white"><X className="w-4 h-4" /></button>
                </div>
                <div ref={chatScrollRef} className="flex-1 min-h-0 overflow-y-auto overscroll-contain no-scrollbar px-3 sm:px-4 py-3">
                  <div className="min-h-full flex flex-col justify-end gap-2">
                  {(room?.chatMessages || []).slice(-60).map((msg: any) => {
                    if (msg.isSystem) {
                      return (
                        <div key={msg.id} className="flex justify-center py-1">
                          <span className="text-[11px] text-gray-500 bg-white/5 border border-white/10 rounded-full px-2.5 py-0.5">👋 {msg.userName} joined</span>
                        </div>
                      );
                    }
                    // participant.id is the socket id — the same key the server stamps on chat messages
                    const isMine = participant ? msg.userId === participant.id : msg.userId === "self";
                    const isAutoDj = msg.userId === "auto-dj" || /auto\s*dj/i.test(msg.userName || "");
                    if (isMine) {
                      return (
                        <div key={msg.id} className="flex justify-end">
                          <div className="max-w-[80%] gradient-bg text-white px-3.5 py-2 rounded-2xl rounded-br-md text-sm break-words shadow-md shadow-purple-500/10">
                            {msg.message}
                          </div>
                        </div>
                      );
                    }
                    return (
                      <div key={msg.id} className="flex items-end gap-2">
                        <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 mb-0.5 ${isAutoDj ? "bg-gradient-to-br from-purple-500 to-pink-500 text-white" : "bg-[#262629] text-gray-300"}`}>
                          {isAutoDj ? "🎧" : (msg.userName || "?").charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0 max-w-[78%]">
                          <p className="text-[11px] text-gray-500 mb-0.5 ml-1 truncate">{isAutoDj ? "Auto DJ" : (msg.userName || "Guest")}</p>
                          <div className={`inline-block px-3 py-2 rounded-2xl rounded-bl-md text-sm break-words ${isAutoDj ? "bg-purple-500/10 border border-purple-500/25 text-purple-100" : "bg-[#262629] text-gray-100"}`}>
                            {msg.message}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  {(room?.chatMessages || []).length === 0 && (
                    <p className="text-gray-500 text-center text-xs pt-8">No messages yet — say hi!</p>
                  )}
                  </div>
                </div>
                <form onSubmit={sendChat} className="shrink-0 p-2.5 border-t border-white/5">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      aria-label="Message"
                      placeholder="Message..."
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      className="flex-1 min-w-0 px-4 py-2.5 bg-[#262629] border-0 rounded-full text-white text-base sm:text-sm placeholder:text-gray-500 outline-none focus:ring-1 focus:ring-vs-accent/60"
                    />
                    <button type="submit" aria-label="Send message" disabled={!chatInput.trim()} className="w-10 h-10 gradient-bg rounded-full flex items-center justify-center disabled:opacity-40 active:scale-95 transition-all shrink-0">
                      <Send className="w-4 h-4 text-white" />
                    </button>
                  </div>
                </form>
              </div>
            ) : (
              <div className="p-4">
                <button onClick={() => setShowChat(true)} className="w-full py-3 border border-white/10 rounded-xl text-sm text-gray-400 hover:text-white hover:border-white/25 transition-all flex items-center justify-center gap-2">
                  <MessageCircle className="w-4 h-4" /> Open chat ({room?.chatMessages?.length || 0})
                </button>
              </div>
            )}
          </section>
        </div>
      </main>

      <nav aria-label="Room navigation" className="room-mobile-nav lg:hidden z-[90] shrink-0 grid grid-cols-3 border-t border-white/10 bg-[#111111] pb-safe">
        <button
          onClick={() => setMobilePanel("player")}
          aria-pressed={mobilePanel === "player"}
          aria-label="Player"
          className={`flex min-h-[60px] flex-col items-center justify-center gap-1 border-t-2 transition-colors focus-visible:text-white ${mobilePanel === "player" ? "border-vs-accent text-vs-accent" : "border-transparent text-gray-500 hover:text-white"}`}
        >
          <Music2 className="h-5 w-5" aria-hidden="true" />
          <span className="text-[10px] font-medium">Player</span>
        </button>
        <button
          onClick={() => setMobilePanel("chat")}
          aria-pressed={mobilePanel === "chat"}
          aria-label={`Chat${unreadChat > 0 ? `, ${unreadChat} unread` : ""}`}
          className={`flex min-h-[60px] flex-col items-center justify-center gap-1 border-t-2 transition-colors focus-visible:text-white ${mobilePanel === "chat" ? "border-vs-accent text-vs-accent" : "border-transparent text-gray-500 hover:text-white"}`}
        >
          <span className="relative">
            <MessageCircle className="h-5 w-5" aria-hidden="true" />
            {unreadChat > 0 && <span className="absolute -right-2 -top-1 min-w-4 rounded-full bg-vs-accent px-1 text-center text-[9px] leading-4 text-white">{unreadChat > 9 ? "9+" : unreadChat}</span>}
          </span>
          <span className="text-[10px] font-medium">Chat</span>
        </button>
        <button
          onClick={() => setMobilePanel("queue")}
          aria-pressed={mobilePanel === "queue"}
          aria-label={`Queue, ${room?.playlist?.length || 0} tracks`}
          className={`flex min-h-[60px] flex-col items-center justify-center gap-1 border-t-2 transition-colors focus-visible:text-white ${mobilePanel === "queue" ? "border-vs-accent text-vs-accent" : "border-transparent text-gray-500 hover:text-white"}`}
        >
          <span className="relative">
            <ListMusic className="h-5 w-5" aria-hidden="true" />
            <span className="absolute -right-2 -top-1 min-w-4 rounded-full bg-white/10 px-1 text-center text-[9px] leading-4 text-gray-300">{room?.playlist?.length || 0}</span>
          </span>
          <span className="text-[10px] font-medium">Queue</span>
        </button>
      </nav>


      {toast && (
        <div role="status" aria-live="polite" className="fixed top-16 left-1/2 -translate-x-1/2 z-[70] glass-panel px-4 py-2 text-sm rounded-full shadow-lg animate-fade-in">
          {toast}
        </div>
      )}

      <audio ref={audioRef} autoPlay playsInline />
      <audio ref={playlistAudioRef} playsInline onEnded={onTrackEnded} />
      <div style={{ position: "fixed", width: 1, height: 1, opacity: 0, pointerEvents: "none", left: -9999 }}>
        <div id="yt-player-host" />
      </div>
    </div>
  );
}

function floorHalf(v: number) { return Math.round(v * 2) / 2; }
