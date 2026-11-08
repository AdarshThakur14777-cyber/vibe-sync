const { io } = require("socket.io-client");

const server = io("http://localhost:3001", { transports: ["websocket"] });
let guest;
let roomId;

server.on("connect", () => {
  console.log("HOST connected:", server.id);
  server.emit("room:create", { name: "Diag Room", hostName: "Host", isPrivate: false }, (result) => {
    if (result.error) { console.error("CREATE failed:", result.error); process.exit(1); }
    roomId = result.roomId;
    console.log("CREATE ok -> roomId:", roomId);

    guest = io("http://localhost:3001", { transports: ["websocket"] });
    guest.on("connect", () => {
      console.log("GUEST connected:", guest.id);
      guest.on("participant:joined", (d) => console.log("GUEST saw participant:joined", d.participant?.id));

      guest.emit("room:join", { roomId, name: "Guest" }, (res) => {
        if (res.error) {
          console.error("JOIN failed:", res.error);
        } else {
          console.log("JOIN ok -> participants:", (res.room.participants || []).map((p) => `${p.id}:${p.role}`));
          console.log("JOIN ok -> playlist:", (res.room.playlist || []).length, "chatMessages:", (res.room.chatMessages || []).length);
          console.log("ALL GOOD — join round-trip works");
        }
        server.disconnect(); guest.disconnect();
        process.exit(0);
      });
    });
  });
});

setTimeout(() => { console.error("TIMEOUT"); process.exit(1); }, 6000);
