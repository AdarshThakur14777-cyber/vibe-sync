export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  artworkUrl: string;
  audioUrl?: string;
  addedBy: string;
  addedByName: string;
  addedAt: Date;
  source: "manual" | "search" | "url";
}

export interface Room {
  id: string;
  name: string;
  hostId: string;
  hostName: string;
  isPrivate: boolean;
  invitationCode: string;
  participants: Map<string, Participant>;
  playlist: Track[];
  currentTrackIndex: number;
  playbackState: PlaybackState;
  createdAt: Date;
  updatedAt: Date;
  streamActive: boolean;
  streamUrl?: string;
  skipVotes: Map<string, string>; // userId -> trackId
  chatMessages: ChatMessage[];
  queueRevision: number;
  collaborativeMode: boolean;
}

export interface Participant {
  id: string;
  name: string;
  avatar?: string;
  role: "host" | "participant";
  joinedAt: Date;
  isOnline: boolean;
  volume: number;
  socketId: string;
}

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  lastUpdate: number;
  duration: number;
  trackId: string;
}

export interface ChatMessage {
  id: string;
  userId: string;
  userName: string;
  userAvatar?: string;
  message: string;
  timestamp: Date;
  reactions: Map<string, string[]>; // emoji -> userIds
}

export interface SkipVote {
  trackId: string;
  votes: Set<string>;
  requiredVotes: number;
}

export type SocketEvent =
  | "room:created"
  | "room:joined"
  | "room:left"
  | "room:error"
  | "playlist:updated"
  | "playlist:track-added"
  | "playlist:track-removed"
  | "playlist:track-reordered"
  | "playback:play"
  | "playback:pause"
  | "playback:skip"
  | "playback:seek"
  | "playback:sync"
  | "playback:state-changed"
  | "skip:vote"
  | "skip:result"
  | "participant:joined"
  | "participant:left"
  | "participant:updated"
  | "chat:message"
  | "chat:message-added"
  | "chat:reaction"
  | "host:stream-started"
  | "host:stream-stopped"
  | "host:stream-status"
  | "webrtc:signal"
  | "webrtc:offer"
  | "webrtc:answer"
  | "webrtc:ice-candidate";

export interface ServerToClientEvents {
  "room:created": (data: { room: Room }) => void;
  "room:joined": (data: { room: Room; participant: Participant }) => void;
  "room:left": (data: { roomId: string; userId: string }) => void;
  "room:error": (data: { message: string }) => void;
  "playlist:updated": (data: { playlist: Track[]; revision: number }) => void;
  "playlist:track-added": (data: { track: Track; revision: number }) => void;
  "playlist:track-removed": (data: { trackId: string; revision: number }) => void;
  "playlist:track-reordered": (data: { playlist: Track[]; revision: number }) => void;
  "playback:play": (data: { trackId: string; timestamp: number }) => void;
  "playback:pause": (data: { timestamp: number }) => void;
  "playback:skip": (data: { trackId: string; timestamp: number }) => void;
  "playback:seek": (data: { timestamp: number }) => void;
  "playback:sync": (data: { currentTime: number; isPlaying: number; trackId: string }) => void;
  "playback:state-changed": (data: PlaybackState) => void;
  "skip:vote": (data: { trackId: string; votes: string[]; required: number }) => void;
  "skip:result": (data: { trackId: string; skipped: boolean }) => void;
  "participant:joined": (data: { participant: Participant }) => void;
  "participant:left": (data: { userId: string }) => void;
  "participant:updated": (data: { participant: Participant }) => void;
  "chat:message-added": (data: { message: ChatMessage }) => void;
  "chat:reaction": (data: { messageId: string; emoji: string; userId: string }) => void;
  "host:stream-started": (data: { streamUrl: string }) => void;
  "host:stream-stopped": (data: {}) => void;
  "host:stream-status": (data: { active: boolean }) => void;
  "webrtc:signal": (data: { from: string; signal: any }) => void;
  "webrtc:offer": (data: { from: string; sdp: any }) => void;
  "webrtc:answer": (data: { from: string; sdp: any }) => void;
  "webrtc:ice-candidate": (data: { from: string; candidate: any }) => void;
}

export interface ClientToServerEvents {
  "room:create": (data: { name: string; isPrivate?: boolean; hostName: string }, callback: (result: { roomId: string; invitationCode: string }) => void) => void;
  "room:join": (data: { roomId: string; name: string }, callback: (result: { room: Room; participant: Participant }) => void) => void;
  "room:leave": (data: { roomId: string; userId: string }) => void;
  "playlist:add": (data: { roomId: string; track: Track }) => void;
  "playlist:remove": (data: { roomId: string; trackId: string }) => void;
  "playlist:reorder": (data: { roomId: string; playlist: Track[] }) => void;
  "playback:play": (data: { roomId: string; trackId: string; timestamp: number }) => void;
  "playback:pause": (data: { roomId: string; timestamp: number }) => void;
  "playback:skip": (data: { roomId: string; trackId: string }) => void;
  "playback:seek": (data: { roomId: string; timestamp: number }) => void;
  "skip:vote": (data: { roomId: string; trackId: string }) => void;
  "chat:message": (data: { roomId: string; message: string; userName: string; userId: string }) => void;
  "chat:reaction": (data: { roomId: string; messageId: string; emoji: string; userId: string }) => void;
  "participant:volume": (data: { roomId: string; userId: string; volume: number }) => void;
  "webrtc:offer": (data: { to: string; sdp: any }) => void;
  "webrtc:answer": (data: { to: string; sdp: any }) => void;
  "webrtc:ice-candidate": (data: { to: string; candidate: any }) => void;
}

export interface InterRoomEvents {}