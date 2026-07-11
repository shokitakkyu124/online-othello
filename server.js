const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'"],
      styleSrc:   ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      objectSrc:  ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const io = new Server(server, {
  maxHttpBufferSize: 1e4,
  pingTimeout: 20000,
  pingInterval: 25000,
});

const MAX_ROOMS          = 500;
const MAX_SOCKETS_PER_IP = 4;
const MOVE_RATE_MS       = 300;
const MSG_RATE_MS        = 2000;
const MAX_MSG_LEN        = 60;
const ROOM_EXPIRE_MS     = 30 * 60 * 1000;
const TURN_TIME_MS       = 15000;
const ROOM_ID_REGEX      = /^\d{4}$/;

const rooms         = new Map();
const ipConnections = new Map();

function secLog(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

// ── 部屋期限タイマー ──────────────────────────────────────────────────────
function resetRoomTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    if (rooms.has(roomId)) {
      io.to(roomId).emit('roomExpired');
      rooms.delete(roomId);
      secLog('room_expired', { roomId });
    }
  }, ROOM_EXPIRE_MS);
}

// ── 手番タイムアウト ──────────────────────────────────────────────────────
function startTurnTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.gameOver) return;
  clearTimeout(room.turnTimer);
  room.turnTimer = setTimeout(() => handleTimeout(roomId), TURN_TIME_MS);
}

function handleTimeout(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.gameOver) return;

  const timedOut = room.currentTurn;
  const next     = timedOut === 'B' ? 'W' : 'B';
  const nextMoves = getValidMoves(room.board, next);
  const selfMoves = getValidMoves(room.board, timedOut);

  secLog('turn_timeout', { roomId, timedOut });

  if (nextMoves.length > 0) {
    room.currentTurn = next;
    io.to(roomId).emit('boardUpdate', {
      board: room.board, currentTurn: room.currentTurn,
      validMoves: nextMoves, lastMove: null, timedOut,
    });
    startTurnTimer(roomId);
  } else if (selfMoves.length > 0) {
    io.to(roomId).emit('boardUpdate', {
      board: room.board, currentTurn: room.currentTurn,
      validMoves: selfMoves, lastMove: null, timedOut, skipped: next,
    });
    startTurnTimer(roomId);
  } else {
    room.gameOver = true;
    const counts = countPieces(room.board);
    const winner = counts.B > counts.W ? 'B' : counts.W > counts.B ? 'W' : null;
    io.to(roomId).emit('gameOver', { board: room.board, counts, winner, lastMove: null });
  }
}

// ── ジャンケンロジック ────────────────────────────────────────────────────
const JK_VALID = new Set(['gu', 'choki', 'pa']);

function jankenWinner(c1, c2) {
  if (c1 === c2) return 'draw';
  if ((c1==='gu'&&c2==='choki') || (c1==='choki'&&c2==='pa') || (c1==='pa'&&c2==='gu')) return 'p1';
  return 'p2';
}

function resolveJanken(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.janken) return;

  const [p1, p2]   = room.players;
  const c1         = room.janken.choices[p1.id];
  const c2         = room.janken.choices[p2.id];
  const result     = jankenWinner(c1, c2);
  const s1         = io.sockets.sockets.get(p1.id);
  const s2         = io.sockets.sockets.get(p2.id);

  if (result === 'draw') {
    if (s1) s1.emit('jankenResult', { myChoice: c1, oppChoice: c2, result: 'draw' });
    if (s2) s2.emit('jankenResult', { myChoice: c2, oppChoice: c1, result: 'draw' });
    setTimeout(() => {
      const r = rooms.get(roomId);
      if (!r || !r.janken) return;
      r.janken.choices = {};
      io.to(roomId).emit('jankenRetry');
    }, 2500);
    return;
  }

  // 勝敗決定 → 色を確定
  const [winP, loseP] = result === 'p1' ? [p1, p2] : [p2, p1];
  const [winC, loseC] = result === 'p1' ? [c1, c2] : [c2, c1];
  const winS  = io.sockets.sockets.get(winP.id);
  const loseS = io.sockets.sockets.get(loseP.id);

  for (const player of room.players) {
    const isWinner = player.id === winP.id;
    player.color = isWinner ? 'B' : 'W';
    const sock = io.sockets.sockets.get(player.id);
    if (sock) sock.color = player.color;
  }

  if (winS)  winS.emit('jankenResult',  { myChoice: winC,  oppChoice: loseC, result: 'win',  newColor: 'B' });
  if (loseS) loseS.emit('jankenResult', { myChoice: loseC, oppChoice: winC,  result: 'lose', newColor: 'W' });

  // 3秒後にゲーム開始
  setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r) return;
    r.janken     = null;
    r.board      = createBoard();
    r.currentTurn = 'B';
    r.gameOver   = false;
    io.to(roomId).emit('gameStart', {
      board: r.board,
      currentTurn: r.currentTurn,
      validMoves: getValidMoves(r.board, 'B'),
    });
    startTurnTimer(roomId);
  }, 3000);
}

// ── オセロロジック ────────────────────────────────────────────────────────
function createBoard() {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  b[3][3]='W'; b[3][4]='B'; b[4][3]='B'; b[4][4]='W';
  return b;
}

const DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

function getFlips(board, row, col, color) {
  const opp = color === 'B' ? 'W' : 'B';
  const flips = [];
  for (const [dr, dc] of DIRS) {
    const line = [];
    let r = row+dr, c = col+dc;
    while (r>=0&&r<8&&c>=0&&c<8&&board[r][c]===opp) { line.push([r,c]); r+=dr; c+=dc; }
    if (line.length>0&&r>=0&&r<8&&c>=0&&c<8&&board[r][c]===color) flips.push(...line);
  }
  return flips;
}

function getValidMoves(board, color) {
  const moves = [];
  for (let r=0;r<8;r++) for (let c=0;c<8;c++)
    if (!board[r][c] && getFlips(board,r,c,color).length>0) moves.push([r,c]);
  return moves;
}

function countPieces(board) {
  let B=0, W=0;
  for (const row of board) for (const cell of row) { if(cell==='B')B++; if(cell==='W')W++; }
  return { B, W };
}

// ── Socket.io ────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const ip = (socket.handshake.headers['x-forwarded-for'] ?? '')
    .split(',')[0].trim() || socket.handshake.address;

  if (!ipConnections.has(ip)) ipConnections.set(ip, new Set());
  const ipSet = ipConnections.get(ip);
  if (ipSet.size >= MAX_SOCKETS_PER_IP) {
    secLog('conn_limit_exceeded', { ip });
    socket.emit('secError', 'Too many connections from your network.');
    socket.disconnect(true);
    return;
  }
  ipSet.add(socket.id);

  let lastMoveAt = 0;
  let lastMsgAt  = 0;

  socket.on('joinRoom', (roomId) => {
    if (typeof roomId !== 'string' || !ROOM_ID_REGEX.test(roomId)) {
      secLog('invalid_room_id', { ip, input: String(roomId).slice(0,40) });
      socket.emit('secError', 'Invalid room ID.');
      return;
    }
    if (!rooms.has(roomId)) {
      if (rooms.size >= MAX_ROOMS) {
        socket.emit('secError', 'Server is at capacity. Try again later.');
        return;
      }
      rooms.set(roomId, {
        board: createBoard(), players: [],
        currentTurn: 'B', gameOver: false,
        timer: null, turnTimer: null, janken: null,
      });
    }
    const room = rooms.get(roomId);
    if (room.players.length >= 2) { socket.emit('roomFull'); return; }

    const color = room.players.length === 0 ? 'B' : 'W';
    room.players.push({ id: socket.id, color });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.color  = color;
    resetRoomTimer(roomId);
    socket.emit('assignColor', color);
    secLog('player_joined', { ip, roomId, color });

    if (room.players.length === 2) {
      room.janken = { choices: {} };
      io.to(roomId).emit('jankenStart');
    } else {
      socket.emit('waiting');
    }
  });

  socket.on('jankenChoice', (choice) => {
    if (!JK_VALID.has(choice)) return;
    const room = rooms.get(socket.roomId);
    if (!room || !room.janken || room.janken.choices[socket.id]) return;
    room.janken.choices[socket.id] = choice;
    socket.to(socket.roomId).emit('opponentChosen');
    if (Object.keys(room.janken.choices).length === 2) resolveJanken(socket.roomId);
  });

  socket.on('makeMove', ({ row, col }) => {
    const now = Date.now();
    if (now - lastMoveAt < MOVE_RATE_MS) return;
    lastMoveAt = now;

    if (!Number.isInteger(row) || !Number.isInteger(col) ||
        row < 0 || row > 7 || col < 0 || col > 7) {
      secLog('invalid_move_input', { ip, row, col });
      return;
    }
    const room = rooms.get(socket.roomId);
    if (!room || room.gameOver) return;
    if (room.currentTurn !== socket.color) return;
    if (room.board[row][col] !== null) return;

    const flips = getFlips(room.board, row, col, socket.color);
    if (flips.length === 0) return;

    clearTimeout(room.turnTimer);

    room.board[row][col] = socket.color;
    for (const [r,c] of flips) room.board[r][c] = socket.color;
    resetRoomTimer(socket.roomId);

    const next         = socket.color === 'B' ? 'W' : 'B';
    const nextMoves    = getValidMoves(room.board, next);
    const currentMoves = getValidMoves(room.board, socket.color);

    if (nextMoves.length > 0) {
      room.currentTurn = next;
      io.to(socket.roomId).emit('boardUpdate', {
        board: room.board, currentTurn: room.currentTurn,
        validMoves: nextMoves, lastMove: { row, col },
      });
      startTurnTimer(socket.roomId);
    } else if (currentMoves.length > 0) {
      io.to(socket.roomId).emit('boardUpdate', {
        board: room.board, currentTurn: room.currentTurn,
        validMoves: currentMoves, lastMove: { row, col }, skipped: next,
      });
      startTurnTimer(socket.roomId);
    } else {
      room.gameOver = true;
      const counts = countPieces(room.board);
      const winner = counts.B > counts.W ? 'B' : counts.W > counts.B ? 'W' : null;
      io.to(socket.roomId).emit('gameOver', {
        board: room.board, counts, winner, lastMove: { row, col },
      });
    }
  });

  socket.on('sendMessage', (text) => {
    const now = Date.now();
    if (now - lastMsgAt < MSG_RATE_MS) return;
    lastMsgAt = now;
    if (typeof text !== 'string') return;
    const cleaned = text.trim().slice(0, MAX_MSG_LEN);
    if (!cleaned) return;
    const room = rooms.get(socket.roomId);
    if (!room) return;
    io.to(socket.roomId).emit('message', { color: socket.color, text: cleaned });
  });

  socket.on('restartGame', () => {
    const room = rooms.get(socket.roomId);
    if (!room || !room.players.some(p => p.id === socket.id)) return;
    clearTimeout(room.turnTimer);
    room.board = createBoard();
    room.currentTurn = 'B';
    room.gameOver = false;
    resetRoomTimer(socket.roomId);
    io.to(socket.roomId).emit('gameStart', {
      board: room.board,
      currentTurn: room.currentTurn,
      validMoves: getValidMoves(room.board, room.currentTurn),
    });
    startTurnTimer(socket.roomId);
  });

  socket.on('disconnect', () => {
    ipSet.delete(socket.id);
    if (ipSet.size === 0) ipConnections.delete(ip);
    const room = rooms.get(socket.roomId);
    if (!room) return;
    clearTimeout(room.turnTimer);
    room.players = room.players.filter(p => p.id !== socket.id);
    io.to(socket.roomId).emit('opponentLeft');
    if (room.players.length === 0) {
      clearTimeout(room.timer);
      rooms.delete(socket.roomId);
    }
  });
});

process.on('uncaughtException',  (err) => secLog('uncaught_exception', { msg: err.message }));
process.on('unhandledRejection', (err) => secLog('unhandled_rejection', { msg: String(err) }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => secLog('server_start', { port: PORT }));
