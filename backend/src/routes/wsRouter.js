import { WebSocketServer } from "ws";

// A single HTTP server must have one WebSocket upgrade dispatcher. Creating
// several WebSocketServer({ server, path }) instances makes them compete for
// the same upgrade event; the first non-matching instance can reject a valid
// request with HTTP 400 before the matching endpoint sees it.
const routers = new WeakMap();

function stateFor(httpServer) {
  let state = routers.get(httpServer);
  if (state) return state;

  state = { paths: new Map() };
  routers.set(httpServer, state);

  httpServer.on("upgrade", (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }

    const wss = state.paths.get(pathname);
    if (!wss) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  return state;
}

export function createPathWebSocketServer(httpServer, pathname) {
  const state = stateFor(httpServer);
  if (state.paths.has(pathname)) {
    throw new Error(`WebSocket path already registered: ${pathname}`);
  }

  const wss = new WebSocketServer({ noServer: true });
  state.paths.set(pathname, wss);
  return wss;
}
