const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");
const express = require("express");
const YTMusicMod = require("ytmusic-api");
const YTMusic = YTMusicMod.default || YTMusicMod;
const yts = require("yt-search");

// ---- YouTube Music catalog search (unofficial) with a plain-YouTube fallback ----
let ytmInstance = null;
async function getYTM() {
  if (ytmInstance) return ytmInstance;
  const inst = new YTMusic();
  if (typeof inst.initialize === "function") await inst.initialize();
  ytmInstance = inst;
  return inst;
}
function parseDuration(d) {
  if (typeof d === "number") return d;
  if (!d) return 0;
  const parts = String(d).split(":").map(Number).reverse();
  return parts.reduce((acc, v, i) => acc + v * Math.pow(60, i), 0);
}

// Indian catalogs (Hindi/Bollywood/Punjabi and all major regional scenes) get
// a ranking boost so they surface first, without excluding anything else.
const INDIAN_RE = /[\u0900-\u097F]|hindi|bollywood|punjabi|bhakti|bhojpuri|tamil|telugu|malayalam|kannada|bengali|marathi|desi|gaana|arijit|shreya|atif aslam|diljit|ap dhillon|sidhu moose|pritam|ar rahman|a\.r\.rahman|sonu nigam|alka yagnik|kumar sanu|jubin nautiyal|armaan malik|badshah|shubh|karan aujla|neha kakkar|sanam|arijit singh/i;
function indianRank(list) {
  const scored = list.map((t, i) => ({
    ...t,
    _indian: INDIAN_RE.test(`${t.title} ${t.artist}`) ? 1 : 0,
    _rank: 1000 - i, // stable original ordering
  }));
  scored.sort((a, b) => (b._indian - a._indian) || (b._rank - a._rank));
  return scored.map(({ _indian, _rank, ...t }) => t);
}

// ---- Auto DJ: learn taste from play history -------------------------------
// history entries newest-first with recency decay; kept as [name, weight]
function roomTaste(room) {
  const hist = [...(room.playHistory || [])].reverse();
  const counts = new Map();
  for (let i = 0; i < hist.length; i++) {
    const h = hist[i];
    const weight = Math.max(1, 10 - i / 6); // recent plays count more
    const artist = String(h.artist || "").trim();
    if (artist && !/^(youtube( music)?|unknown)$/i.test(artist)) {
      counts.set(artist, (counts.get(artist) || 0) + weight);
    }
    const title = String(h.title || "");
    const lead = title.split(/\s[-–—]\s/)[0].trim();
    if (lead.length > 2 && lead.length < 40 && !/^youtube/i.test(lead)) {
      counts.set(lead, (counts.get(lead) || 0) + weight / 2);
    }
  }
  if (!counts.size) return [];
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
}

// Seeds used until the room has enough listening history to derive taste
const AUTO_DJ_SEEDS = [
  "top hindi songs 2026", "arijit singh hits", "ap dhillon", "punjabi top hits",
  "tamil hit songs", "bollywood romantic hits", "ar rahman evergreen", "telugu hit songs",
];

function recordPlay(room, track) {
  if (!track) return;
  const vid = track.youtubeId || track.id || "";
  const last = room.playHistory[room.playHistory.length - 1];
  if (last && last.videoId === vid) return; // don't stack the same track back-to-back
  room.playHistory.push({
    videoId: vid, id: track.id || "", title: track.title || "", artist: track.artist || "",
    playedAt: new Date().toISOString(),
  });
  if (room.playHistory.length > 60) room.playHistory.shift();
}

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST"], credentials: true },
  allowEIO3: true,
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3001;
const rooms = new Map();

// ---- room persistence: survive backend restarts ---------------------------
const ROOMS_FILE = path.join(__dirname, "rooms-state.json");

function serializeRoom(room) {
  const toPairs = (v) => (v instanceof Map ? Array.from(v) : (Array.isArray(v) ? v.filter(Array.isArray) : Object.entries(v || {})));
  return {
    ...room,
    participants: toPairs(room.participants),
    skipVotes: toPairs(room.skipVotes),
    chatMessages: (room.chatMessages || []).map((m) => ({ ...m, reactions: m instanceof Map ? Array.from(m) : (Array.isArray(m?.reactions) ? m.reactions : Object.entries(m?.reactions || {})) })),
  };
}

function persistRooms() {
  try {
    // never clobber a saved file with an empty snapshot — the empty window
    // right after boot or a transient clear must not erase saved playlists
    if (rooms.size === 0 && fs.existsSync(ROOMS_FILE)) {
      const existing = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"));
      if (Object.keys(existing).length > 0) return;
    }
    const plain = {};
    for (const [id, room] of rooms) plain[id] = serializeRoom(room);
    const tmp = ROOMS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(plain));
    fs.renameSync(tmp, ROOMS_FILE); // atomic-ish swap
  } catch (e) {
    console.log("persist failed:", e.message);
  }
}

function loadRooms() {
  try {
    const raw = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8"));
    for (const [id, room] of Object.entries(raw)) {
      try {
        // defensively normalize: saved entries may be pairs-arrays, flat
        // arrays of objects, or plain objects — never let one bad field drop a room
        const toPairs = (v, idKey) => (Array.isArray(v) ? v : Object.entries(v || {}))
          .map((e) => (Array.isArray(e) ? e : e && typeof e === "object" && e[idKey] ? [e[idKey], e] : null))
          .filter(Boolean);
        // everyone was disconnected by definition — the restart killed the sockets
        room.participants = new Map(toPairs(room.participants, "id").map(([pid, p]) => [pid, { ...(p || {}), isOnline: false, socketId: null }]));
        room.skipVotes = new Map(toPairs(room.skipVotes, "id").map(([uid, v]) => [uid, v === true ? [] : v]));
        if (!Array.isArray(room.playlist)) room.playlist = [];
        // backfill: tracks saved before youtubeId existed (Auto DJ) can't be
        // played by the embed without it — map videoId in on load
        room.playlist = room.playlist.map((t) => (t && t.videoId && !t.youtubeId ? { ...t, youtubeId: t.videoId } : t));
        if (!Array.isArray(room.chatMessages)) room.chatMessages = [];
        room.chatMessages = room.chatMessages.map((m) => ({ ...m, reactions: new Map(Array.isArray(m?.reactions) ? m.reactions : Object.entries(m?.reactions || {})) }));
        if (!Array.isArray(room.playHistory)) room.playHistory = [];
        if (!room.autoDjLock) room.autoDjLock = 0;
        if (!room.playbackState || typeof room.playbackState !== "object") room.playbackState = { isPlaying: false, currentTime: 0, lastUpdate: Date.now(), duration: 0, trackId: "" };
        rooms.set(id, room);
      } catch (e) {
        console.log("skipping bad saved room", id, ":", e.message);
      }
    }
    console.log("restored rooms from disk:", rooms.size);
  } catch (e) {
    /* no file yet or unreadable — first boot */
    console.log("loadRooms skipped:", e.message);
  }
}
loadRooms();
setInterval(persistRooms, 5000);

function generateRoomId() {
  return Math.random().toString(36).substring(2, 10).toUpperCase();
}
function generateInvitationCode() {
  return Math.random().toString(36).substring(2, 12);
}

function createRoom({ roomName, hostName, hostId, isPrivate }) {
  const roomId = generateRoomId();
  const invitationCode = generateInvitationCode();
  const now = new Date();
  const room = {
    id: roomId, name: roomName || "VibeSync Room", hostId, hostName,
    // rooms are ALWAYS private — joining happens only through the host's invite link
    isPrivate: true, invitationCode,
    participants: new Map(), playlist: [], currentTrackIndex: -1,
    playbackState: { isPlaying: false, currentTime: 0, lastUpdate: Date.now(), duration: 0, trackId: "" },
    createdAt: now, updatedAt: now, streamActive: false,
    skipVotes: new Map(), chatMessages: [], queueRevision: 0, collaborativeMode: true,
    playHistory: [], autoDjLock: 0,
  };
  const hostParticipant = { id: hostId, name: hostName, role: "host", joinedAt: now, isOnline: true, volume: 100, socketId: null };
  room.participants.set(hostId, hostParticipant);
  rooms.set(roomId, room);
  return room;
}
function getRoom(roomId) { return rooms.get(roomId); }
function addParticipant(room, participant) { room.participants.set(participant.id, participant); room.updatedAt = new Date(); }
function removeParticipant(room, userId) { room.participants.delete(userId); room.skipVotes.delete(userId); room.updatedAt = new Date(); }

// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);
  let currentUserId = null;
  let currentRoomId = null;

  socket.on("room:create", (data, callback) => {
    try {
      const { name: roomName, hostName, isPrivate } = data;
      const hostId = socket.id;
      currentUserId = hostId;
      const room = createRoom({ roomName, hostName, hostId, isPrivate });
      currentRoomId = room.id;
      room.participants.get(hostId).socketId = socket.id;
      socket.join(room.id);
      callback({ roomId: room.id, invitationCode: room.invitationCode });
      console.log(`Room created: ${room.id} by ${hostName}`);
    } catch (err) {
      callback({ error: err.message });
    }
  });

  socket.on("room:join", (data, callback) => {
    try {
      const { roomId: roomIdInput, name: participantName } = data;
      const room = getRoom(roomIdInput);
      if (!room) { callback({ error: "Room not found" }); return; }
      const userId = socket.id;
      currentUserId = userId;
      currentRoomId = room.id;
      // host identity survives restarts/reloads: match by stored hostName too,
      // and let a returning host reclaim the room with their fresh socket id
      const isHost = userId === room.hostId || participantName === room.hostName;
      const role = isHost ? "host" : "participant";
      if (isHost && room.hostId !== userId) {
        room.hostId = userId;
        console.log(`Host reclaimed room ${room.id} as ${participantName} (${userId})`);
      }
      if (room.participants.has(userId)) {
        const p = room.participants.get(userId);
        p.socketId = socket.id; p.isOnline = true; p.name = participantName;
      } else {
        const participant = { id: userId, name: participantName, role, joinedAt: new Date(), isOnline: true, volume: 100, socketId: socket.id };
        addParticipant(room, participant);
      }
      // prune ghosts: participants restored from disk (isOnline=false) whose
      // sockets died with the old process — announce them as left too
      for (const [pid, p] of room.participants) {
        if (pid !== userId && !p.isOnline) {
          room.participants.delete(pid);
          io.to(room.id).emit("participant:left", { userId: pid });
        }
      }
      socket.join(room.id);
      callback({ room: serializeRoom(room), participant: room.participants.get(userId) });
      socket.to(room.id).emit("participant:joined", { participant: room.participants.get(userId) });
      console.log(`Participant joined: ${participantName} (${userId}) in room ${room.id}`);
    } catch (err) {
      callback({ error: err.message });
    }
  });

  socket.on("room:leave", (data) => {
    const { roomId, userId } = data;
    handleLeave(roomId, userId, socket);
  });

  socket.on("playlist:add", (data) => {
    const { roomId, track } = data;
    const room = getRoom(roomId);
    if (!room || !room.collaborativeMode) return;
    room.playlist.push(track);
    room.queueRevision += 1;
    room.updatedAt = new Date();
    io.to(roomId).emit("playlist:track-added", { track, revision: room.queueRevision });
    io.to(roomId).emit("playlist:updated", { playlist: room.playlist, revision: room.queueRevision });
  });

  socket.on("playlist:remove", (data) => {
    const { roomId, trackId } = data;
    const room = getRoom(roomId);
    if (!room || !room.collaborativeMode) return;
    room.playlist = room.playlist.filter((t) => t.id !== trackId);
    room.queueRevision += 1;
    room.updatedAt = new Date();
    io.to(roomId).emit("playlist:track-removed", { trackId, revision: room.queueRevision });
    io.to(roomId).emit("playlist:updated", { playlist: room.playlist, revision: room.queueRevision });
  });

  socket.on("playlist:reorder", (data) => {
    const { roomId, playlist } = data;
    const room = getRoom(roomId);
    if (!room || !room.collaborativeMode) return;
    room.playlist = playlist;
    room.queueRevision += 1;
    room.updatedAt = new Date();
    io.to(roomId).emit("playlist:track-reordered", { playlist: room.playlist, revision: room.queueRevision });
  });

  socket.on("playback:play", (data) => {
    const { roomId, trackId, timestamp } = data;
    const room = getRoom(roomId);
    if (!room) return;
    room.playbackState = { isPlaying: true, currentTime: timestamp || 0, lastUpdate: Date.now(), duration: room.playbackState.duration, trackId };
    const playedTrack = room.playlist.find((t) => t.id === trackId);
    if (playedTrack) recordPlay(room, playedTrack);
    room.updatedAt = new Date();
    io.to(roomId).emit("playback:play", { trackId, timestamp: timestamp || 0, track: playedTrack || null });
  });

  socket.on("playback:pause", (data) => {
    const { roomId, timestamp } = data;
    const room = getRoom(roomId);
    if (!room) return;
    room.playbackState = { ...room.playbackState, isPlaying: false, currentTime: timestamp || room.playbackState.currentTime, lastUpdate: Date.now() };
    room.updatedAt = new Date();
    io.to(roomId).emit("playback:pause", { timestamp: timestamp || room.playbackState.currentTime });
  });

  socket.on("playback:skip", (data) => {
    const { roomId, trackId } = data;
    const room = getRoom(roomId);
    if (!room) return;
    // Skip is instant for everyone now, so guard against double-taps / stale
    // emits: only skip when the target really is the room's current track.
    if (trackId && room.playbackState?.trackId && trackId !== room.playbackState.trackId) return;
    const currentIndex = room.playlist.findIndex((t) => t.id === (trackId || room.playbackState?.trackId));
    const nextIndex = currentIndex + 1;
    if (nextIndex < room.playlist.length) {
      room.currentTrackIndex = nextIndex;
      room.playbackState = { isPlaying: true, currentTime: 0, lastUpdate: Date.now(), duration: room.playlist[nextIndex].duration, trackId: room.playlist[nextIndex].id };
      recordPlay(room, room.playlist[nextIndex]);
    } else {
      // Queue drained — clear playback so Auto DJ is allowed to pick something
      // from the room's listening taste instead of getting "already-playing".
      room.playbackState = { isPlaying: false, currentTime: 0, lastUpdate: Date.now(), duration: room.playbackState?.duration || 0, trackId: "" };
      room.currentTrackIndex = -1;
    }
    room.skipVotes.clear();
    room.updatedAt = new Date();
    io.to(roomId).emit("playback:skip", { trackId: room.playlist[nextIndex]?.id || "", timestamp: 0 });
  });

  socket.on("playback:seek", (data) => {
    const { roomId, timestamp } = data;
    const room = getRoom(roomId);
    if (!room) return;
    room.playbackState = { ...room.playbackState, currentTime: timestamp, lastUpdate: Date.now() };
    room.updatedAt = new Date();
    io.to(roomId).emit("playback:seek", { timestamp });
  });

  socket.on("skip:vote", (data) => {
    const { roomId, trackId } = data;
    const room = getRoom(roomId);
    if (!room) return;
    const userId = socket.id;
    if (!room.skipVotes.has(trackId)) room.skipVotes.set(trackId, new Set());
    room.skipVotes.get(trackId).add(userId);
    const votes = room.skipVotes.get(trackId);
    const required = Math.max(2, Math.ceil(room.participants.size / 2));
    io.to(roomId).emit("skip:vote", { trackId, votes: Array.from(votes), required });
    if (votes.size >= required) {
      room.skipVotes.delete(trackId);
      io.to(roomId).emit("skip:result", { trackId, skipped: true });
    }
  });

  socket.on("chat:message", (data) => {
    const { roomId, message, userName, userId } = data;
    const room = getRoom(roomId);
    if (!room) return;
    const chatMessage = { id: Math.random().toString(36).substring(2, 12), userId, userName, message: message.trim(), timestamp: new Date(), reactions: new Map() };
    room.chatMessages.push(chatMessage);
    room.updatedAt = new Date();
    io.to(roomId).emit("chat:message-added", { message: chatMessage });
  });

  socket.on("chat:reaction", (data) => {
    const { roomId, messageId, emoji, userId } = data;
    const room = getRoom(roomId);
    if (!room) return;
    const message = room.chatMessages.find((m) => m.id === messageId);
    if (!message) return;
    if (!message.reactions.has(emoji)) message.reactions.set(emoji, []);
    const users = message.reactions.get(emoji);
    if (users.includes(userId)) { const idx = users.indexOf(userId); users.splice(idx, 1); if (users.length === 0) message.reactions.delete(emoji); }
    else { users.push(userId); }
    io.to(roomId).emit("chat:reaction", { messageId, emoji, userId });
  });

  socket.on("participant:volume", (data) => {
    const { roomId, userId, volume } = data;
    const room = getRoom(roomId);
    if (!room) return;
    const participant = room.participants.get(userId);
    if (participant) participant.volume = volume;
  });

  socket.on("webrtc:offer", (data) => { const { to, sdp } = data; io.to(to).emit("webrtc:offer", { from: socket.id, sdp }); });
  socket.on("webrtc:answer", (data) => { const { to, sdp } = data; io.to(to).emit("webrtc:answer", { from: socket.id, sdp }); });
  socket.on("webrtc:ice-candidate", (data) => { const { to, candidate } = data; io.to(to).emit("webrtc:ice-candidate", { from: socket.id, candidate }); });

  socket.on("host:stream-status", (data) => {
    const { roomId, active } = data;
    const room = getRoom(roomId);
    if (!room) return;
    room.streamActive = active;
    room.updatedAt = new Date();
    socket.to(roomId).emit("host:stream-status", { active });
  });

  socket.on("disconnect", () => {
    const userId = currentUserId;
    const roomId = currentRoomId;
    if (roomId && userId) handleLeave(roomId, userId, socket);
    console.log(`User disconnected: ${socket.id}`);
  });
});

function handleLeave(roomId, userId, socket) {
  const room = getRoom(roomId);
  if (!room) return;
  socket.leave(roomId);
  if (room.participants.has(userId)) {
    const participant = room.participants.get(userId);
    participant.isOnline = false;
    participant.socketId = null;
    if (participant.role === "host") {
      room.streamActive = false;
      io.to(roomId).emit("host:stream-stopped", {});
      io.to(roomId).emit("participant:left", { userId });
    } else {
      io.to(roomId).emit("participant:left", { userId });
    }
    room.updatedAt = new Date();
  }
}

function serializeRoom(room) {
  return {
    ...room,
    participants: Array.from(room.participants.entries()).map(([id, p]) => p),
    skipVotes: Object.fromEntries(Array.from(room.skipVotes.entries(), ([k, v]) => [k, Array.from(v)])),
    chatMessages: room.chatMessages.map((m) => ({ ...m, reactions: Object.fromEntries(Array.from(m.reactions.entries(), ([k, v]) => [k, v])) })),
  };
}

app.get("/health", (req, res) => { res.json({ status: "ok", rooms: rooms.size }); });

app.get("/suggest", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 2) return res.json({ suggestions: [] });
  try {
    const ytm = await getYTM();
    let raw = null;
    try {
      raw = await ytm.getSearchSuggestions(q);
    } catch {
      const sres = await ytm.search(q, "SONGS");
      raw = (sres || []).slice(0, 8).map((s) => [s.artist && s.artist.name, s.name || s.title].filter(Boolean).join(" - "));
    }
    const suggestions = (raw || []).filter((x) => typeof x === "string" && x.trim()).slice(0, 8);
    if (suggestions.length) return res.json({ suggestions });
    console.log("Suggest empty for:", q);
  } catch (e) {
    console.log("Suggest failed:", e.message);
  }
  return res.json({ suggestions: [] });
});

app.get("/search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ results: [] });

  try {
    const ytm = await getYTM();
    // Songs + Videos merged so the result list is deep enough to keep
    // revealing new rows while the user scrolls ("endless" search).
    const toSongRaw = (s) => {
      if (!s || !s.videoId) return null;
      return {
        videoId: s.videoId,
        title: s.name || s.title || "Unknown track",
        artist: (s.artist && s.artist.name) || s.artist || "YouTube Music",
        duration: parseDuration(s.duration),
        // yt3.googleusercontent.com channel avatars are hotlink-blocked in <img>
        // contexts — always hand out a real video thumbnail instead.
        thumbnail: `https://i.ytimg.com/vi/${s.videoId}/hqdefault.jpg`,
        source: "ytmusic",
      };
    };
    let songs = [];
    let videos = [];
    try { songs = await ytm.searchSongs(q); } catch { songs = []; }
    try { videos = await ytm.searchVideos(q); } catch { videos = []; }
    if (!songs.length && !videos.length) {
      // legacy shape fallback for odd networks
      try { songs = await ytm.search(q, "SONGS"); } catch {}
    }
    const seen = new Set();
    const list = [];
    for (const s of [...(songs || []), ...(videos || [])]) {
      const raw = toSongRaw(s);
      if (!raw || seen.has(raw.videoId)) continue;
      seen.add(raw.videoId);
      list.push(raw);
      if (list.length >= 60) break;
    }
    if (list.length) return res.json({ results: indianRank(list) });
    console.log("YTMusic returned no results for:", q);
  } catch (e) {
    console.log("YTMusic search failed, falling back:", e.message);
  }
  try {
    const r = await yts(q);
    const list = (r.all || [])
      .filter((v) => v && v.videoId)
      .slice(0, 14)
      .map((v) => ({
        videoId: v.videoId,
        title: v.title || "Unknown track",
        artist: (v.author && v.author.name) || "YouTube",
        duration: v.seconds || 0,
        thumbnail: v.image || `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        source: "youtube",
      }));
    return res.json({ results: indianRank(list).slice(0, 14) });

  } catch (e2) {
    console.log("yt-search fallback failed:", e2.message);
    return res.status(500).json({ error: "Search failed" });
  }
});
app.get("/room/:roomId", (req, res) => {
  const room = getRoom(req.params.roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  res.json(serializeRoom(room));
});

// ---- Auto DJ: server-arbitrated track math --------------------------------
// Many tabs can request at once (track end fires on every client); the lock
// collapses them into ONE add. Track selection: taste from play history,
// never repeating queued/played tracks; Indian seeds until there's history.
app.post("/autoDj", async (req, res) => {
  const { roomId, endedTrackId } = req.body || {};
  const room = getRoom(roomId);
  if (!room) return res.status(404).json({ error: "Room not found" });
  const endedTrackIsCurrent = Boolean(endedTrackId && room.playbackState?.trackId === endedTrackId);
  if (room.playbackState?.isPlaying && !endedTrackIsCurrent) return res.json({ track: null, reason: "already-playing" });
  const now = Date.now();
  if (now - (room.autoDjLock || 0) < 10000) return res.json({ track: null, reason: "locked" });
  room.autoDjLock = now;
  if (endedTrackIsCurrent && room.playbackState?.isPlaying) {
    room.playbackState = { ...room.playbackState, isPlaying: false, lastUpdate: now };
    io.to(roomId).emit("playback:pause", { timestamp: room.playbackState.currentTime || 0 });
  }

  try {
    const queuedOrPlayed = new Set([
      ...(room.playlist || []).map((t) => t.youtubeId || t.id),
      ...(room.playHistory || []).map((h) => h.videoId),
    ]);
    const taste = roomTaste(room);
    const queries = [];
    if (taste.length) {
      // strongest taste first, plus one wildcard mix of the top taste
      const top = taste[0][0];
      queries.push(top, `${top} songs`, taste.slice(0, 3).join(" "));
    }
    const seed = AUTO_DJ_SEEDS[(now / 60000) % AUTO_DJ_SEEDS.length | 0]; // rotates every minute
    queries.push(seed);

    const ytm = await getYTM();
    for (const q of queries.filter(Boolean)) {
      let found = null;
      try {
        found = await ytm.search(q, "SONGS");
      } catch {
        try { found = await ytm.search(q); } catch {}
      }
      const fresh = (found || [])
        .filter((s) => s && s.videoId && !queuedOrPlayed.has(s.videoId))
        .slice(0, 6)
        .map((s) => ({
          videoId: s.videoId,
          title: s.name || s.title || "Unknown track",
          artist: (s.artist && s.artist.name) || s.artist || "YouTube Music",
          duration: parseDuration(s.duration),
          thumbnail: `https://i.ytimg.com/vi/${s.videoId}/hqdefault.jpg`,
          source: "ytmusic",
        }));
      if (!fresh.length) continue;
      const pick = indianRank(fresh)[0];

      // add server-side (same broadcast shape as the socket handler) so every
      // client's queue stays consistent — no separate client add step needed
      const track = {
        id: `yt-${pick.videoId}-auto-${Math.random().toString(36).slice(2, 8)}`,
        ...pick,
        // clients drive the YT embed with track.youtubeId AND track.artworkUrl
        youtubeId: pick.videoId,
        artworkUrl: pick.thumbnail,
        album: "", audioUrl: "",
        addedBy: "auto-dj", addedByName: "Auto DJ 🎧",
        addedAt: new Date(),
      };
      room.playlist.push(track);
      room.queueRevision += 1;
      room.updatedAt = new Date();
      io.to(roomId).emit("playlist:track-added", { track, revision: room.queueRevision });
      io.to(roomId).emit("playlist:updated", { playlist: room.playlist, revision: room.queueRevision });

      const chatMessage = {
        id: Math.random().toString(36).substring(2, 12),
        userId: "auto-dj", userName: "Auto DJ",
        message: `Added "${track.title}" ${taste.length ? "from your listening taste" : "to keep the vibe going"} 🎧`,
        timestamp: new Date(),
        reactions: new Map(),
      };
      room.chatMessages.push(chatMessage);
      io.to(roomId).emit("chat:message-added", { message: chatMessage });
      console.log(`Auto DJ: added "${track.title}" to ${roomId} (taste: ${taste.map(([n]) => n).join(", ") || "seed"})`);
      return res.json({ track });
    }
    return res.json({ track: null, reason: "no-candidates" });
  } catch (e) {
    console.log("Auto DJ failed:", e.message);
    room.autoDjLock = 0; // release so a retry can happen
    return res.status(500).json({ error: "Auto DJ failed" });
  }
});

server.listen(PORT, () => { console.log(`VibeSync backend server running on port ${PORT}`); });
module.exports = { app, server, io };