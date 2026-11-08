# VibeSync - Real-Time Collaborative Music Streaming

A private proof-of-concept for real-time collaborative music listening where one host broadcasts browser-tab audio to invited friends via WebRTC.

## Features

- **Host broadcasts audio**: Share any Brave Browser tab's audio via WebRTC
- **Listeners join via link**: No installation required, works in any modern browser
- **Collaborative playlist**: Add tracks, vote to skip, reorder queue
- **Real-time chat**: Group chat with emoji reactions
- **Host controls**: Start/stop streaming, manage participants, room settings
- **WebRTC signaling**: Low-latency audio delivery via Socket.IO
- **Responsive UI**: Dark mode with glassmorphism, works on desktop and mobile

## Architecture

```
Host (Brave Browser)
    ↓
navigator.mediaDevices.getDisplayMedia() - Tab audio capture
    ↓
WebRTC PeerConnection - Audio broadcasting
    ↓
Socket.IO Signaling - Offer/Answer/ICE candidates
    ↓
Listener (Browser)
    ↓
HTML5 Audio - Playback of received stream
```

## Tech Stack

- **Frontend**: Next.js 15, React 19, TypeScript, Tailwind CSS, Framer Motion, Lucide Icons
- **Backend**: Node.js, Express, Socket.IO
- **State**: In-memory (MVP), upgrade path to Redis/Supabase
- **Audio**: WebRTC, MediaDevices API, HTML5 Audio API

## Project Structure

```
vibe-sync/
├── src/
│   ├── app/
│   │   ├── page.tsx              # Landing page
│   │   ├── host/page.tsx         # Host dashboard
│   │   └── room/[roomId]/page.tsx # Listening room
│   ├── components/               # Reusable components
│   ├── lib/                      # Utilities & Supabase config
│   ├── hooks/                    # Custom React hooks
│   ├── contexts/                 # React context providers
│   └── types/                    # TypeScript type definitions
├── backend/
│   ├── server.js                 # Socket.IO + WebRTC signaling server
│   └── package.json
├── public/
├── .env.example
├── package.json
└── README.md
```

## Installation

### Prerequisites

- Node.js 18+
- npm or yarn
- Two different browsers (for testing host vs listener)

### Backend Setup

```bash
cd backend
npm install
```

### Frontend Setup

```bash
npm install
```

### Environment Variables

Copy `.env.example` to `.env.local` and configure:

```bash
cp .env.example .env.local
```

## Running Locally

### Start Backend

```bash
cd backend
npm start
# Server runs on http://localhost:3001
```

### Start Frontend

```bash
npm run dev:frontend
# Frontend runs on http://localhost:3000
```

### Start Both (Concurrently)

```bash
npm run dev
```

## Testing with Two Browsers

1. **Host Setup**:
   - Open http://localhost:3000 in Browser A (Brave recommended)
   - Click "Create Listening Room"
   - Enter host name and room name
   - Room is created with a unique ID and invitation link

2. **Listener Setup**:
   - Open the invitation link in Browser B (or different profile)
   - Enter a nickname and join the room
   - Click "Start Listening" if prompted by browser autoplay policy

3. **Start Streaming**:
   - In Browser A (host), click "Share Tab Audio"
   - Select a browser tab with audio (e.g., a music site)
   - Click "Share" in the browser's screen capture dialog
   - Audio begins broadcasting to all listeners

4. **Collaborate**:
   - Both users can add tracks to the shared queue
   - Vote to skip the current track
   - Send chat messages
   - Host can manage participants

## How It Works

### Audio Streaming

1. Host calls `navigator.mediaDevices.getDisplayMedia({ audio: true, video: false })`
2. User selects a tab to share audio from
3. The audio track is extracted and broadcast via WebRTC PeerConnection
4. Listeners receive the stream through WebRTC and play it via HTML5 Audio

### WebRTC Signaling

- Socket.IO relays WebRTC offers, answers, and ICE candidates between host and listeners
- STUN server (stun.l.google.com:19302) is used for NAT traversal
- For production, configure TURN servers for relay

### Collaborative Playlist

- Server-authoritative queue with revision numbers
- Socket.IO events synchronize playlist changes across all clients
- Skip voting requires majority consensus

### Security

- Unpredictable room IDs (8-char alphanumeric)
- Socket.IO event validation on server
- Rate limiting for chat and queue updates
- Host-only stream control

## Deployment

### Frontend (Vercel)

```bash
vercel deploy
```

### Backend (Node.js hosting)

Deploy `backend/server.js` to any WebSocket-capable Node.js host (Railway, Render, Fly.io, etc.)

```bash
cd backend
npm start
```

Set `CORS_ORIGIN` to your frontend domain.

## Important Notes

- **HTTPS required**: Browser audio capture requires HTTPS in production
- **No copyright bypass**: This tool does not bypass DRM or extract audio from protected services
- **Private use only**: Only broadcast audio you have rights to share
- **MVP limitations**: 2-5 listeners, in-memory state, direct peer connections

## License

Private proof-of-concept. Not for production use without security review.