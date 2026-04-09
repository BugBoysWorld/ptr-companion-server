/**
 * Paint the Roses — Multiplayer WebSocket Server
 *
 * Architecture:
 *   - Pure in-memory state — no database needed
 *   - One "room" per game session identified by a 6-char code
 *   - Server stores the full shared event log (same JSON objects the .md log uses)
 *   - Clients replay the event log locally to reconstruct board/tracker state
 *   - Whim card symbols NEVER reach the server — private to each device
 *
 * Deploy to Railway:
 *   1. Push this folder to GitHub
 *   2. Connect repo to Railway, set start command: node server.js
 *   3. Railway assigns a public URL — paste it into the app's room screen
 */

const WebSocket = require('ws');
const http = require('http');

// ── CONFIG ────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// ── ROOM STORE ────────────────────────────────────────────────────
// rooms[code] = {
//   code,
//   hostId,
//   numPlayers,
//   players: [{id, name, diff, connected, lastTilePlaced}],
//   eventLog: [],          // all public events in chronological order
//   pendingClues: {},      // {playerId: tokens} — collecting per-player submissions
//   pendingHex: null,      // hex where the pending tile was placed
//   pendingTile: null,     // {color, shape} of the pending tile
//   started: false,
//   createdAt: Date
// }
const rooms = {};

// ── HELPERS ───────────────────────────────────────────────────────
function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/1/I confusion
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? makeCode() : code; // ensure unique
}

function now() {
  return new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
}

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(room, msg, excludeId = null) {
  room.players.forEach(p => {
    if (p.id !== excludeId && p.ws && p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(msg));
    }
  });
}

function broadcastAll(room, msg) {
  broadcast(room, msg, null);
}

// Push event to server log and broadcast to all clients
function pushEvent(room, event) {
  room.eventLog.push(event);
  broadcastAll(room, { type: 'log_event', entry: event });
}

// Find the index of the last turn event in the log
function lastTurnIdx(room) {
  for (let i = room.eventLog.length - 1; i >= 0; i--) {
    if (room.eventLog[i].type === 'turn') return i;
  }
  return -1;
}

// Check if all connected players have submitted clues
function allCluesIn(room) {
  return room.players.every(p => !p.connected || p.id in room.pendingClues);
}

// ── WEBSOCKET SERVER ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // Simple health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: Object.keys(rooms).length,
      players: Object.values(rooms).reduce((n, r) => n + r.players.filter(p => p.connected).length, 0)
    }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
  let room = null;
  let playerId = null;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── HOST CREATES A ROOM ─────────────────────────────────────
      case 'create_room': {
        const code = makeCode();
        const newRoom = {
          code,
          hostId: 0,
          numPlayers: msg.numPlayers || 2,
          players: [],
          eventLog: [],
          pendingClues: {},
          pendingHex: null,
          pendingTile: null,
          started: false,
          createdAt: Date.now()
        };
        rooms[code] = newRoom;
        room = newRoom;
        playerId = 0;

        // Register host as player 0
        room.players.push({
          id: 0,
          name: msg.playerName || 'Player 1 (You)',
          diff: msg.diff || 'hard',
          connected: true,
          lastTilePlaced: false,
          ws
        });

        send(ws, { type: 'room_created', code, yourPlayerId: 0 });
        console.log(`Room ${code} created by ${msg.playerName}`);
        break;
      }

      // ── PLAYER JOINS A ROOM ─────────────────────────────────────
      case 'join_room': {
        const r = rooms[msg.code];
        if (!r) { send(ws, { type: 'error', msg: 'Room not found.' }); break; }
        if (r.started && !msg.rejoin) {
          send(ws, { type: 'error', msg: 'Game already started.' }); break;
        }

        // Check if this is a rejoin (same name + same slot)
        const existing = r.players.find(p => p.name === msg.playerName && !p.connected);
        if (existing) {
          // Reconnect to existing slot
          existing.connected = true;
          existing.ws = ws;
          playerId = existing.id;
          room = r;
          send(ws, {
            type: 'room_joined',
            yourPlayerId: existing.id,
            players: r.players.map(p => ({ id: p.id, name: p.name, diff: p.diff, connected: p.connected })),
            eventLog: r.eventLog,
            started: r.started
          });
          broadcast(r, { type: 'player_reconnected', playerId: existing.id, playerName: existing.name }, existing.id);
          console.log(`${msg.playerName} reconnected to room ${msg.code}`);
          break;
        }

        // New join
        if (r.players.length >= r.numPlayers) {
          send(ws, { type: 'error', msg: 'Room is full.' }); break;
        }

        playerId = r.players.length;
        room = r;
        r.players.push({
          id: playerId,
          name: msg.playerName || `Player ${playerId + 1}`,
          diff: msg.diff || 'hard',
          connected: true,
          lastTilePlaced: false,
          ws
        });

        send(ws, {
          type: 'room_joined',
          yourPlayerId: playerId,
          players: r.players.map(p => ({ id: p.id, name: p.name, diff: p.diff, connected: p.connected })),
          eventLog: r.eventLog,
          started: r.started
        });

        // Tell everyone else
        broadcast(r, {
          type: 'player_joined',
          playerId,
          playerName: msg.playerName,
          diff: msg.diff,
          totalJoined: r.players.length,
          numPlayers: r.numPlayers
        }, playerId);

        console.log(`${msg.playerName} joined room ${msg.code} (${r.players.length}/${r.numPlayers})`);
        break;
      }

      // ── HOST STARTS THE GAME ────────────────────────────────────
      case 'start_game': {
        if (!room || playerId !== room.hostId) break;
        room.started = true;

        // Store the game_start event — uses same format as the .md log
        const startEvent = {
          type: 'game_start',
          timestamp: now(),
          players: room.players.map(p => ({ name: p.name, diff: p.diff })),
          startingTiles: msg.startingTiles || []
        };
        pushEvent(room, startEvent);

        broadcastAll(room, { type: 'game_started', players: room.players.map(p => ({ id: p.id, name: p.name, diff: p.diff })) });
        console.log(`Room ${room.code} game started`);
        break;
      }

      // ── TILE PLACED ─────────────────────────────────────────────
      case 'tile_placed': {
        if (!room) break;
        // Track who placed the last tile (for undo auth)
        room.players.forEach(p => p.lastTilePlaced = (p.id === playerId));
        // Store pending placement — waiting for clue submissions
        room.pendingClues = {};
        room.pendingHex = msg.hexId;
        room.pendingTile = { color: msg.color, shape: msg.shape };
        // Broadcast placement to all other clients
        broadcast(room, {
          type: 'tile_placed',
          hexId: msg.hexId,
          color: msg.color,
          shape: msg.shape,
          byPlayerId: playerId
        }, playerId);
        // Tell everyone to show the clue logger
        broadcastAll(room, {
          type: 'show_clue_logger',
          hexId: msg.hexId,
          tile: `${msg.color} ${msg.shape}`,
          placedByPlayerId: playerId
        });
        break;
      }

      // ── TILE CLEARED (UNDO) ─────────────────────────────────────
      case 'tile_cleared': {
        if (!room) break;
        // Auth: only the placer or the host can undo
        const placer = room.players.find(p => p.lastTilePlaced);
        const isHost = playerId === room.hostId;
        const isPlacer = placer && placer.id === playerId;
        if (!isHost && !isPlacer) {
          send(ws, { type: 'error', msg: 'Only the tile placer or host can undo.' });
          break;
        }
        // Roll back event log to before the last turn event
        const lastTurn = lastTurnIdx(room);
        if (lastTurn !== -1) room.eventLog.splice(lastTurn, 1);
        // Clear pending clues
        room.pendingClues = {};
        room.pendingHex = null;
        room.pendingTile = null;
        room.players.forEach(p => p.lastTilePlaced = false);
        // Tell all clients to roll back — they re-replay the trimmed log
        broadcastAll(room, {
          type: 'tile_cleared',
          hexId: msg.hexId,
          eventLog: room.eventLog   // send full log for clean replay
        });
        break;
      }

      // ── GREENHOUSE UPDATED ──────────────────────────────────────
      case 'gh_update': {
        if (!room) break;
        broadcast(room, { type: 'gh_update', gh: msg.gh }, playerId);
        break;
      }

      // ── PLAYER SUBMITS THEIR OWN CLUE COUNT ────────────────────
      case 'clue_submit': {
        if (!room) break;
        room.pendingClues[playerId] = msg.tokens;

        // Tell everyone this player has submitted (without revealing the count yet)
        broadcastAll(room, {
          type: 'clue_submitted',
          playerId,
          playerName: room.players.find(p => p.id === playerId)?.name
        });

        // If all connected players have submitted, fire clues_logged
        if (allCluesIn(room)) {
          const clues = room.players.map(p => ({
            name: p.name,
            tokens: room.pendingClues[p.id] ?? 0  // unconnected players get 0 (host fills manually)
          }));

          const turnEvent = {
            type: 'turn',
            turn: room.eventLog.filter(e => e.type === 'turn').length + 1,
            timestamp: now(),
            hex: room.pendingHex,
            tileColor: room.pendingTile?.color,
            tileShape: room.pendingTile?.shape,
            tile: `${room.pendingTile?.color} ${room.pendingTile?.shape}`,
            neighbors: msg.neighbors || '',
            clues,
            trackerChanges: [],   // each client computes this locally
            anSnap: msg.anSnap || null
          };

          pushEvent(room, turnEvent);
          room.pendingClues = {};
          room.pendingHex = null;
          room.pendingTile = null;
          room.players.forEach(p => p.lastTilePlaced = false);
        }
        break;
      }

      // ── HOST FILLS IN CLUE FOR UNCONNECTED PLAYER ──────────────
      case 'clue_override': {
        // Host manually enters tokens for a player who isn't connected
        if (!room || playerId !== room.hostId) break;
        room.pendingClues[msg.forPlayerId] = msg.tokens;
        if (allCluesIn(room)) {
          // Same as above — trigger clues_logged
          const clues = room.players.map(p => ({
            name: p.name,
            tokens: room.pendingClues[p.id] ?? 0
          }));
          const turnEvent = {
            type: 'turn',
            turn: room.eventLog.filter(e => e.type === 'turn').length + 1,
            timestamp: now(),
            hex: room.pendingHex,
            tileColor: room.pendingTile?.color,
            tileShape: room.pendingTile?.shape,
            tile: `${room.pendingTile?.color} ${room.pendingTile?.shape}`,
            neighbors: msg.neighbors || '',
            clues,
            trackerChanges: [],
            anSnap: msg.anSnap || null
          };
          pushEvent(room, turnEvent);
          room.pendingClues = {};
          room.pendingHex = null;
          room.pendingTile = null;
          room.players.forEach(p => p.lastTilePlaced = false);
        }
        break;
      }

      // ── TRACKER CELL MANUALLY UPDATED ──────────────────────────
      case 'tracker_manual': {
        if (!room) break;
        const manualEvent = {
          type: 'tracker_manual',
          timestamp: now(),
          player: room.players.find(p => p.id === playerId)?.name,
          pair: msg.pair,
          from: msg.from,
          to: msg.to
        };
        pushEvent(room, manualEvent);
        break;
      }

      // ── WHIM CARD GUESSED / RESET ───────────────────────────────
      case 'whim_reset': {
        if (!room) break;
        const p = room.players.find(p => p.id === msg.playerIdx);
        if (p) {
          const oldDiff = p.diff;
          p.diff = msg.newDiff;
          const resetEvent = {
            type: 'whim_guessed',
            timestamp: now(),
            player: p.name,
            oldDiff,
            newDiff: msg.newDiff
          };
          pushEvent(room, resetEvent);
        }
        break;
      }

      // ── REQUEST FULL SYNC (reconnect catch-up) ──────────────────
      case 'request_sync': {
        if (!room) break;
        send(ws, {
          type: 'sync',
          eventLog: room.eventLog,
          players: room.players.map(p => ({ id: p.id, name: p.name, diff: p.diff, connected: p.connected }))
        });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!room || playerId === null) return;
    const p = room.players.find(p => p.id === playerId);
    if (p) {
      p.connected = false;
      p.ws = null;
      broadcast(room, { type: 'player_disconnected', playerId, playerName: p.name }, playerId);
      console.log(`${p.name} disconnected from room ${room.code}`);
    }
    // Clean up empty rooms after 2 hours
    const allGone = room.players.every(p => !p.connected);
    if (allGone) {
      setTimeout(() => {
        if (rooms[room.code] && room.players.every(p => !p.connected)) {
          delete rooms[room.code];
          console.log(`Room ${room.code} cleaned up`);
        }
      }, 2 * 60 * 60 * 1000);
    }
  });

  ws.on('error', err => console.error('WS error:', err.message));
});

server.listen(PORT, () => {
  console.log(`Paint the Roses server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// ── CLEANUP: remove stale rooms every hour ───────────────────────
setInterval(() => {
  const cutoff = Date.now() - (12 * 60 * 60 * 1000); // 12 hours
  Object.entries(rooms).forEach(([code, r]) => {
    if (r.createdAt < cutoff) {
      delete rooms[code];
      console.log(`Stale room ${code} removed`);
    }
  });
}, 60 * 60 * 1000);
