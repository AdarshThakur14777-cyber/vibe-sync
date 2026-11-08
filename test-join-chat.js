// E2E helper: join a second user and send a chat message (verifies joined-pill + member chips + left bubble)
const { io } = require("socket.io-client");
const roomId = process.argv[2] || "1GU54NY6";
const name = process.argv[3] || "Priya";
const say = process.argv[4] || "hi everyone! this chat is so smooth 😍";

const holdMs = Number(process.argv[5]) || 1200;
const s = io("http://localhost:3001", { transports: ["websocket"], forceNew: true });
s.on("connect", () => {
  s.emit("room:join", { roomId, name }, (result) => {
    if (result.error) { console.log("JOIN ERROR:", result.error); process.exit(1); }
    console.log("joined as", name, "in", roomId);
    setTimeout(() => {
      s.emit("chat:message", { roomId, message: say, userName: name, userId: s.id });
      console.log("sent chat:", say);
      setTimeout(() => { s.disconnect(); process.exit(0); }, holdMs);
    }, 800);
  });
});
s.on("connect_error", (e) => { console.log("CONNECT ERROR:", e.message); process.exit(1); });
