"use client";

// A real /room/:id/search page — not a dialog overlay. Browser back works,
// the URL is shareable, and the room's bottom nav stays available: it lives
// right here in the layout and tab-switching returns to /room/:id?panel=…

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { io } from "socket.io-client";
import {
  ArrowLeft, ArrowRight, Play, Pause, Search, X,
  Music2, MessageCircle, ListMusic, Zap,
  Heart, TrendingUp,
} from "lucide-react";

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || "http://localhost:3001";

export default function RoomSearchPage() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // /room/ABCD1234/search → "search" is last; the room code is the segment before
  const roomId = pathname.split("/").reverse().find((seg) => seg.toUpperCase() !== "SEARCH" && seg) || "";
  const userName = searchParams.get("name") || "Guest";

  const [q, setQ] = useState(() => searchParams.get("q") || "");
  const [chips, setChips] = useState<string[]>([]);
  const [results, setResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socketRef = useRef<any>(null);

  // Endless scroll: the search pool reveals in batches of 12 as you scroll
  const [visibleCount, setVisibleCount] = useState(12);
  const [loadingMore, setLoadingMore] = useState(false);
  const listScrollRef = useRef<HTMLDivElement | null>(null);

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  };

  // Lightweight socket — used only for add-to-queue / play-now emits. It never
  // joins the room, so opening the search page doesn't bump participant count.
  useEffect(() => {
    const socket = io(SOCKET_URL, { reconnectionAttempts: 5 });
    socketRef.current = socket;
    return () => { socket.disconnect(); };
  }, []);

  const doSearch = (query: string, { silent = false }: { silent?: boolean } = {}) => {
    const term = query.trim();
    if (!term) return;
    if (!silent) setSearching(true);
    setVisibleCount(12);
    setLoadingMore(false);
    fetch(`${SOCKET_URL}/search?q=${encodeURIComponent(term)}`)
      .then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then((data) => {
        // a newer keystroke has taken over — discard this answer
        if (qRef.current.trim() !== term) return;
        setResults(data.results || []);
        setSearchError((data.results || []).length ? null : "No results found.");
      })
      .catch(() => {
        if (qRef.current.trim() === term) setSearchError("Search failed — is the backend running?");
      })
      .finally(() => {
        if (qRef.current.trim() === term) setSearching(false);
      });
  };

  // keep the latest query available inside async callbacks
  const qRef = useRef(q);
  useEffect(() => { qRef.current = q; }, [q]);

  // Live suggestions + results while typing (debounced 400ms)
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setChips([]);
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const [res, sug] = await Promise.allSettled([
          fetch(`${SOCKET_URL}/search?q=${encodeURIComponent(term)}`),
          fetch(`${SOCKET_URL}/suggest?q=${encodeURIComponent(term)}`),
        ]);
        if (res.status === "fulfilled" && res.value.ok) {
          const data = await res.value.json();
          setResults(data.results || []);
          setSearchError((data.results || []).length ? null : "No results found.");
        }
        if (sug.status === "fulfilled" && sug.value.ok) {
          const data = await sug.value.json();
          setChips(data.suggestions || []);
        }
      } catch {
        // typing search is sugar — errors surface on explicit search only
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [q]);

  // Endless-scroll reveal: watch the list's scroll position directly — near the
  // bottom, load the next batch (skeletons bridge the 350ms stagger).
  const visibleCountRef = useRef(visibleCount);
  useEffect(() => { visibleCountRef.current = visibleCount; }, [visibleCount]);
  const loadingMoreRef = useRef(loadingMore);
  useEffect(() => { loadingMoreRef.current = loadingMore; }, [loadingMore]);
  const resultsRef = useRef(results);
  useEffect(() => { resultsRef.current = results; }, [results]);
  const searchingRef = useRef(searching);
  useEffect(() => { searchingRef.current = searching; }, [searching]);

  useEffect(() => {
    const scroller = listScrollRef.current;
    if (!scroller) return;
    const reveal = () => {
      if (searchingRef.current || loadingMoreRef.current) return;
      const total = resultsRef.current.length;
      if (visibleCountRef.current >= total) return;
      if (scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 220) return;
      setLoadingMore(true);
      setTimeout(() => {
        setVisibleCount((c) => Math.min(c + 12, resultsRef.current.length));
        setLoadingMore(false);
      }, 350);
    };
    scroller.addEventListener("scroll", reveal, { passive: true });
    reveal(); // already at the bottom (short screens / few results)?
    return () => scroller.removeEventListener("scroll", reveal);
  }, [results, searching]);

  // ---- Mini player on the search page ---------------------------------------
  // The search page never joins the room (no participant-count spam), so it
  // polls REST for room state instead of using the socket broadcast.
  const [nowPlaying, setNowPlaying] = useState<{
    trackId: string; title: string; artist: string; artworkUrl: string;
    isPlaying: boolean; currentTime: number; duration: number;
  } | null>(null);
  const nowPlayingRef = useRef(nowPlaying);
  useEffect(() => { nowPlayingRef.current = nowPlaying; }, [nowPlaying]);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`${SOCKET_URL}/room/${roomId}`);
        if (!res.ok) return;
        const room = await res.json();
        if (cancelled) return;
        const ps = room.playbackState || {};
        const track = (room.playlist || []).find((t: any) => t.id === ps.trackId) ||
          room.playbackState?.track || null;
        const elapsed = (ps.currentTime || 0) + (ps.isPlaying ? (Date.now() - (ps.lastUpdate || Date.now())) / 1000 : 0);
        if (track) {
          setNowPlaying({
            trackId: track.id,
            title: track.title || "Unknown track",
            artist: track.artist || "",
            artworkUrl: track.artworkUrl || "",
            isPlaying: !!ps.isPlaying,
            currentTime: Math.max(0, elapsed),
            duration: track.duration || ps.duration || 0,
          });
        } else {
          setNowPlaying(null);
        }
      } catch {
        // mini player is sugar on this page — polling errors are silent
      }
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [roomId]);

  // Auto-play a recommendation when there's no track (Next pressed on idle)
  const autoPlayRecommendation = async () => {
    const socket = socketRef.current;
    if (!socket) return;
    try {
      const res = await fetch(`${SOCKET_URL}/autoDj`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId }),
      });
      if (!res.ok) return;
      const data = await res.json();
      if (data.track) socket.emit("playback:play", { roomId, trackId: data.track.id, timestamp: 0 });
    } catch {
      // best effort
    }
  };

  const miniToggle = () => {
    const np = nowPlayingRef.current;
    const socket = socketRef.current;
    if (!socket) return;
    if (!np?.trackId) {
      autoPlayRecommendation();
      return;
    }
    if (np.isPlaying) {
      socket.emit("playback:pause", { roomId, timestamp: Math.round(np.currentTime) });
    } else {
      socket.emit("playback:play", { roomId, trackId: np.trackId, timestamp: Math.round(np.currentTime) });
    }
  };

  const miniNext = () => {
    const np = nowPlayingRef.current;
    const socket = socketRef.current;
    if (!socket) return;
    if (np?.trackId) {
      socket.emit("playback:skip", { roomId, trackId: np.trackId });
      // this page isn't in the room, so it never sees the empty-skip broadcast —
      // re-check shortly and kick Auto DJ if the queue drained.
      setTimeout(async () => {
        try {
          const res = await fetch(`${SOCKET_URL}/room/${roomId}`);
          if (!res.ok) return;
          const room = await res.json();
          const ps = room.playbackState || {};
          if (ps.trackId || room.playlist?.length) return; // next track already pinned
          await autoPlayRecommendation();
        } catch {}
      }, 1500);
    } else {
      autoPlayRecommendation();
    }
  };

  const backToRoom = (panel: string) =>
    `/room/${roomId}?name=${encodeURIComponent(userName)}&panel=${panel}`;

  const addSearchResult = (r: any) => {
    const socket = socketRef.current;
    if (!socket) return;
    const track = {
      id: `yt-${r.videoId}-${Math.random().toString(36).slice(2, 8)}`,
      title: r.title,
      artist: r.artist,
      album: "",
      duration: r.duration || 0,
      artworkUrl: r.thumbnail || `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`,
      audioUrl: "",
      addedBy: socket.id,
      addedByName: userName,
      addedAt: new Date(),
      source: "youtube",
      youtubeId: r.videoId,
    };
    socket.emit("playlist:add", { roomId, track });
    setResults((prev) => prev.filter((x) => x.videoId !== r.videoId));
    showToast("Added to queue 🎶");
  };

  // Center ▶ on a card: queue it AND start it playing immediately.
  const playSearchResultNow = (r: any) => {
    const socket = socketRef.current;
    if (!socket) return;
    const track = {
      id: `yt-${r.videoId}-${Math.random().toString(36).slice(2, 8)}`,
      title: r.title,
      artist: r.artist,
      album: "",
      duration: r.duration || 0,
      artworkUrl: r.thumbnail || `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`,
      audioUrl: "",
      addedBy: socket.id,
      addedByName: userName,
      addedAt: new Date(),
      source: "youtube",
      youtubeId: r.videoId,
    };
    socket.emit("playlist:add", { roomId, track });
    socket.emit("playback:play", { roomId, trackId: track.id, timestamp: 0 });
    showToast(`Now playing: ${r.title} ▶`);
  };

  const formatTime = (s: number) => {
    if (!s || !isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, "0");
    return `${m}:${sec}`;
  };

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

  return (
    <div className="h-[100dvh] flex flex-col bg-[#0a0a0a] text-white">
      {/* Page header — back arrow + search input, like a pushed page */}
      <div className="flex items-center gap-1.5 p-3 sm:p-4 border-b border-white/5 shrink-0">
        <Link
          href={backToRoom("queue")}
          aria-label="Back to room"
          className="w-11 h-11 flex items-center justify-center rounded-full text-gray-400 hover:text-white hover:bg-white/5 transition-colors shrink-0"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="relative flex-1 max-w-2xl">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-500 pointer-events-none" />
          <input
            autoFocus
            type="text"
            aria-label="Search YouTube music"
            placeholder="Songs, artists, moods — search anything…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                doSearch(q);
              }
            }}
            className="w-full px-11 py-2.5 bg-[#141414] border border-white/10 rounded-full text-white focus:border-vs-accent text-sm min-h-[44px]"
            autoComplete="off"
          />
          {q && (
            <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 p-2.5 text-gray-500 hover:text-white transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Page body */}
      <div ref={listScrollRef} className="flex-1 min-h-0 overflow-y-auto no-scrollbar p-3 sm:p-6">
        <div className="max-w-4xl mx-auto">
          {q.trim().length === 0 ? (
            <div className="space-y-5">
              <div>
                <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2.5">
                  {chips.length > 0 ? "Search suggestions" : "Quick picks"}
                </h4>
                <div className="flex flex-wrap gap-1.5">
                  {(chips.length > 0 ? chips : QUICK_PICKS).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setQ(p)}
                      className="px-3 py-1.5 rounded-full bg-vs-accent/10 border border-vs-accent/20 text-xs font-medium text-vs-accent hover:bg-vs-accent/20 transition-colors"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2.5">Trending Now 🇮🇳</h4>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                  {TRENDING_SUGGESTIONS.map((s) => (
                    <button
                      key={s.query}
                      type="button"
                      onClick={() => setQ(s.query)}
                      className="p-3 text-left bg-white/5 border border-white/10 rounded-xl hover:border-vs-accent/50 hover:bg-white/10 transition-colors group"
                    >
                      <s.icon className="w-4 h-4 text-vs-accent mb-1.5" aria-hidden="true" />
                      <p className="text-xs font-semibold text-white group-hover:text-vs-accent truncate">{s.title}</p>
                      <p className="text-[10px] text-gray-500 truncate">{s.subtitle}</p>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : results.length > 0 ? (
            <>
              {chips.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {chips.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setQ(p)}
                      className="px-2.5 py-1 rounded-full bg-vs-accent/10 border border-vs-accent/20 text-[11px] font-medium text-vs-accent hover:bg-vs-accent/20 transition-colors"
                    >
                      {p}
                    </button>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {results.slice(0, visibleCount).map((r) => (
                  <div key={r.videoId} className="glass-panel rounded-xl p-3 hover:bg-white/10 transition-colors group">
                    <div className="relative w-24 h-24 sm:w-full sm:h-auto sm:aspect-square rounded-full overflow-hidden mx-auto mb-2.5 border-2 border-white/10 bg-gray-800">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={r.thumbnail || `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`}
                        alt=""
                        className="w-full h-full object-cover"
                        onError={(e) => {
                          const el = e.currentTarget;
                          const fb = `https://i.ytimg.com/vi/${r.videoId}/hqdefault.jpg`;
                          if (el.src !== fb) el.src = fb; else el.style.visibility = "hidden";
                        }}
                      />
                      {/* Center play: tap here and the track starts INSTANTLY */}
                      <button
                        type="button"
                        title="Play now"
                        aria-label={`Play ${r.title} now`}
                        onClick={() => playSearchResultNow(r)}
                        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-black/60 backdrop-blur-sm border border-white/25 flex items-center justify-center text-white hover:bg-vs-accent hover:border-vs-accent active:scale-90 transition-all shadow-lg"
                      >
                        <Play className="w-5 h-5 sm:w-6 sm:h-6 translate-x-[1px]" />
                      </button>
                    </div>
                    <p className="text-sm font-semibold truncate">{r.title}</p>
                    <p className="text-xs text-gray-500 truncate">{r.artist}</p>
                    <div className="flex items-center justify-between mt-2.5">
                      <span className="text-[11px] text-gray-500">{formatTime(r.duration)}</span>
                      <button type="button" onClick={() => addSearchResult(r)} className="px-4 py-2 min-h-[36px] gradient-bg rounded-full text-xs font-bold shrink-0 active:scale-95 transition-transform">
                        Queue
                      </button>
                    </div>
                  </div>
                ))}
                {Array.from({ length: loadingMore ? Math.min(12, results.length - visibleCount) : 0 }).map((_, i) => (
                  <div key={`sk-${i}`} className="glass-panel rounded-xl p-3 animate-pulse">
                    <div className="w-24 h-24 sm:w-full sm:aspect-square rounded-full bg-white/5 mx-auto mb-2.5" />
                    <div className="h-3 bg-white/5 rounded mb-1.5" />
                    <div className="h-2.5 bg-white/5 rounded w-2/3" />
                  </div>
                ))}
              </div>
              <div className="h-4" />
              {visibleCount >= results.length && results.length > 12 ? (
                <p className="text-center text-[11px] text-gray-600 pb-2">That&apos;s everything for this search 🎧</p>
              ) : visibleCount < results.length && !loadingMore ? (
                <p className="text-center text-[11px] text-gray-600 pb-2">Scroll for more…</p>
              ) : null}
            </>
          ) : searching ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="glass-panel rounded-xl p-3 animate-pulse">
                  <div className="w-24 h-24 sm:w-full sm:aspect-square rounded-full bg-white/5 mx-auto mb-2.5" />
                  <div className="h-3 bg-white/5 rounded mb-1.5" />
                  <div className="h-2.5 bg-white/5 rounded w-2/3" />
                </div>
              ))}
            </div>
          ) : (
            <p className="text-gray-500 text-sm text-center py-10">{searchError || (q.trim().length >= 2 ? "…" : "Search anything — artists, songs, moods…")}</p>
          )}
        </div>
      </div>

      {/* Mini player — full control from the search tab; tapping the card
          expands to the room's Player tab */}
      <div className="shrink-0 px-3 pb-1.5 pt-1">
        {nowPlaying ? (
          <Link
            href={backToRoom("player")}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-[#141414] p-2 hover:border-vs-accent/40 transition-colors"
          >
            <div className="relative w-11 h-11 rounded-full overflow-hidden border border-white/10 bg-gray-800 shrink-0">
              {nowPlaying.artworkUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={nowPlaying.artworkUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <span className="w-full h-full flex items-center justify-center text-vs-accent/50"><Music2 className="w-4 h-4" /></span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold truncate">{nowPlaying.title}</p>
              <p className="text-[11px] text-gray-500 truncate">{nowPlaying.artist}</p>
              <div className="mt-1 h-1 rounded-full bg-white/10 overflow-hidden">
                <div
                  className="h-full gradient-bg"
                  style={{ width: nowPlaying.duration ? `${Math.min(100, (nowPlaying.currentTime / nowPlaying.duration) * 100)}%` : "0%" }}
                />
              </div>
            </div>
            {/* stop the card-tap so the buttons toggle, not navigate */}
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); miniToggle(); }}
              aria-label={nowPlaying.isPlaying ? "Pause" : "Play"}
              className="w-10 h-10 rounded-full gradient-bg flex items-center justify-center shrink-0 active:scale-90 transition-transform"
            >
              {nowPlaying.isPlaying ? <Pause className="w-4 h-4 text-white" /> : <Play className="w-4 h-4 text-white ml-0.5" />}
            </button>
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); miniNext(); }}
              aria-label="Next track"
              className="w-10 h-10 rounded-full bg-white/5 border border-white/10 flex items-center justify-center text-gray-300 hover:text-white shrink-0 active:scale-90 transition-transform"
            >
              <ArrowRight className="w-4 h-4" />
            </button>
          </Link>
        ) : (
          <button
            type="button"
            onClick={autoPlayRecommendation}
            className="w-full flex items-center gap-3 rounded-xl border border-white/10 bg-[#141414] p-2.5 text-left hover:border-vs-accent/40 transition-colors"
          >
            <span className="w-9 h-9 rounded-full bg-vs-accent/10 border border-vs-accent/20 flex items-center justify-center shrink-0">
              <Zap className="w-4 h-4 text-vs-accent" />
            </span>
            <span className="flex-1 min-w-0">
              <span className="block text-sm font-semibold">Nothing playing</span>
              <span className="block text-[11px] text-gray-500">Tap for Auto DJ — music from your taste</span>
            </span>
            <Play className="w-5 h-5 text-vs-accent shrink-0" />
          </button>
        )}
      </div>

      {/* Room bottom nav — stays visible on the search page; the buttons
          return to the room with the right tab open */}
      <nav aria-label="Room navigation" className="room-mobile-nav lg:hidden z-[90] shrink-0 grid grid-cols-3 border-t border-white/10 bg-[#111111] pb-safe">
        <Link href={backToRoom("player")} className="flex flex-col items-center justify-center gap-0.5 py-2 text-vs-accent min-h-[56px]">
          <Play className="w-5 h-5" />
          <span className="text-[10px] font-medium">Player</span>
        </Link>
        <Link href={backToRoom("chat")} className="flex flex-col items-center justify-center gap-0.5 py-2 text-gray-400 hover:text-white min-h-[56px]">
          <MessageCircle className="w-5 h-5" />
          <span className="text-[10px] font-medium">Chat</span>
        </Link>
        <Link href={backToRoom("queue")} className="flex flex-col items-center justify-center gap-0.5 py-2 text-gray-400 hover:text-white min-h-[56px]">
          <ListMusic className="w-5 h-5" />
          <span className="text-[10px] font-medium">Queue</span>
        </Link>
      </nav>

      {toast && (
        <div role="status" aria-live="polite" className="fixed top-16 left-1/2 -translate-x-1/2 z-[70] glass-panel px-4 py-2 text-sm rounded-full shadow-lg animate-fade-in">
          {toast}
        </div>
      )}
    </div>
  );
}
