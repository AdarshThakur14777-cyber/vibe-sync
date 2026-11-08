const { io } = require("socket.io-client");

async function main() {
  // 1) create a fresh room as host
  const create = await new Promise((resolve, reject) => {
    const s = io("http://localhost:3001", { transports: ["websocket"], forceNew: true });
    s.on("connect", () => s.emit("room:create", { name: "AutoDJ-Test", hostName: "Host", isPrivate: true }, (r) => { s.disconnect(); resolve(r); }));
    setTimeout(() => reject(new Error("create timeout")), 8000);
  });
  if (create.error) throw new Error("create error: " + create.error);
  console.log("create raw:", JSON.stringify(create).slice(0, 300));
  const roomId = create.room?.id || create.roomId;
  console.log("room created:", roomId);

  // 2) nobody adds anything — hit POST /autoDj (the idle path)
  const res = await fetch("http://localhost:3001/autoDj", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId }),
  });
  const data = await res.json();
  console.log("autoDj status:", res.status, "| track:", data.track ? `"${data.track.title}" — ${data.track.artist}` : `none (${data.reason})`);

  // 3) read the room back: playlist + chat should reflect the auto-add
  const room = await (await fetch(`http://localhost:3001/room/${roomId}`)).json();
  console.log("playlist now:", (room.playlist || []).length, "track(s):", (room.playlist || []).map((t) => t.title));
  (room.chatMessages || []).slice(-3).forEach((m) => console.log("  chat:", m.userName, "→", m.message));

  // 4) lock check: second call while not playing after a fresh track must be
  //    allowed again (lock only blocks concurrent) — but isPlaying is false,
  //    so a second call within 10s should be "locked"
  const res2 = await fetch("http://localhost:3001/autoDj", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomId }) });
  const d2 = await res2.json();
  console.log("second call →", d2.track ? "track (lock failed!)" : `none (${d2.reason})`);

  console.log("DONE roomId=" + roomId);
}
main().catch((e) => { console.log("TEST FAILED:", e.message); process.exit(1); });
