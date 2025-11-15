const WebSocket = require("ws");
const PORT = process.env.PORT || 3000;

const wss = new WebSocket.Server({ port: PORT });

console.log("Signaling server running on port:", PORT);

let rooms = {}; // roomId: [clients]

wss.on("connection", (ws) => {
    ws.on("message", (msg) => {
        let data;
        try {
            data = JSON.parse(msg);
        } catch (err) {
            return;
        }

        const { type, roomId } = data;

        if (type === "join") {
            if (!rooms[roomId]) rooms[roomId] = [];
            rooms[roomId].push(ws);
            ws.roomId = roomId;

            console.log("Client joined room:", roomId);
        }

        // forward message to all peers in the room
        if (rooms[roomId]) {
            rooms[roomId].forEach((client) => {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(msg);
                }
            });
        }
    });

    ws.on("close", () => {
        const roomId = ws.roomId;
        if (roomId && rooms[roomId]) {
            rooms[roomId] = rooms[roomId].filter((c) => c !== ws);
        }
    });
});
