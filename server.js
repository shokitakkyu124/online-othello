const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);

// ── 1. セキュリティヘッダー (Helmet) ──────────────────────────────────────
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

// ── 2. HTTP レート制限（15 分で最大 120 リクエスト/IP）────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

app.use(express.static('public'));

// ── 3. ヘルスチェックエンドポイント ──────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── 4. Socket.io ─────────────────────────────────────────────────────────
const io = new Server(server, {
  maxHttpBufferSize: 1e4,      // ペイロード上限 10KB
  pingTimeout: 20000,
  pingInterval: 25000,
});

// ── 定数 ──────────────────────────────────────────────────────────────────
const MAX_ROOMS             = 500;
const MAX_SOCKETS_PER_IP    = 4;
const MOVE_RATE_LIMIT_MS    = 300;   // 連続手の最小間隔
const ROOM_EXPIRE_MS        = 30 * 60 * 1000;  // 30 分で部屋を自動削除
const ROOM_ID_REGEX         = /^[A-Za-z0-9]{1,20}$/;

const rooms         = new Map();   // roomId -> room
const ipConnections = new Map();   // ip -> Set<socketId>

// ── セキュリティログ ──────────────────────────────────────────────────────
function secLog(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

// ── 部屋の自動削除タイマー ────────────────────────────────────────────────
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

// ── オセロロジック ────────────────────────────────────────────────────────
function createBoard() {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  b[3][3]='W'; b[3][4]='B'; b[4][3]='B'; b[4][4]='W';
  return b;
}

const DIRS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

function getFlips(board, row, col, color) {
  const opp = color==='B' ? 'W' : 'B';
  const flips = [];
  for (const [dr,dc] of DIRS) {
    const line = [];
    let r=row+dr, c=col+dc;
    while (r>=0&&r<8&&c>=0&&c<8&&board[r][c]===opp) { line.push([r,c]); r+=dr; c+=dc; }
    if (line.length>0&&r>=0&&r<8&&c>=0&&c<8&&board[r][c]===color) flips.push(...line);
  }
  return flips;
}

function getValidMoves(board, color) {
  const moves=[];
  for (let r=0;r<8;r++) for (let c=0;c<8;c++)
    if (!board[r][c]&&getFlips(board,r,c,color).length>0) moves.push([r,c]);
  return moves;
}

function countPieces(board) {
  let B=0,W=0;
  for (const row of board) for (const cell of row) { if(cell==='B')B++; if(cell==='W')W++; }
  return {B,W};
}

// ── Socket.io 接続処理 ────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // 実 IP 取得（Render はリバースプロキシ経由）
  const ip = (socket.handshake.headers['x-forwarded-for'] ?? '')
    .split(',')[0].trim() || socket.handshake.address;

  // 5. IP あたりの接続数制限
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

  // ── joinRoom ──
  socket.on('joinRoom', (roomId) => {
    // 6. ルームID バリデーション
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
        board: createBoard(),
        players: [],
        currentTurn: 'B',
        gameOver: false,
        timer: null,
      });
    }

    const room = rooms.get(roomId);
    if (room.players.length >= 2) { socket.emit('roomFull'); return; }

    const color = room.players.length === 0 ? 'B' : 'W';
    room.players.push({ id: socket.id, color });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.color = color;
    resetRoomTimer(roomId);

    socket.emit('assignColor', color);
    secLog('player_joined', { ip, roomId, color });

    if (room.players.length === 2) {
      io.to(roomId).emit('gameStart', {
        board: room.board,
        currentTurn: room.currentTurn,
        validMoves: getValidMoves(room.board, room.currentTurn),
      });
    } else {
      socket.emit('waiting');
    }
  });

  // ── makeMove ──
  socket.on('makeMove', ({ row, col }) => {
    // 7. 手のレート制限
    const now = Date.now();
    if (now - lastMoveAt < MOVE_RATE_LIMIT_MS) {
      secLog('move_rate_limit', { ip, socketId: socket.id });
      return;
    }
    lastMoveAt = now;

    // 8. 手の入力バリデーション（プロトタイプ汚染対策含む）
    if (!Number.isInteger(row) || !Number.isInteger(col) ||
        row < 0 || row > 7 || col < 0 || col > 7) {
      secLog('invalid_move_input', { ip, row, col });
      return;
    }

    const room = rooms.get(socket.roomId);
    if (!room || room.gameOver) return;

    // 9. 手番チェック（サーバー側で強制）
    if (room.currentTurn !== socket.color) {
      secLog('wrong_turn', { ip, color: socket.color, turn: room.currentTurn });
      return;
    }

    // 10. そのマスが空であることを確認
    if (room.board[row][col] !== null) return;

    // 11. 有効な手であることを確認
    const flips = getFlips(room.board, row, col, socket.color);
    if (flips.length === 0) {
      secLog('invalid_move_no_flip', { ip, row, col });
      return;
    }

    room.board[row][col] = socket.color;
    for (const [r,c] of flips) room.board[r][c] = socket.color;
    resetRoomTimer(socket.roomId);

    const next = socket.color==='B' ? 'W' : 'B';
    const nextMoves    = getValidMoves(room.board, next);
    const currentMoves = getValidMoves(room.board, socket.color);

    if (nextMoves.length > 0) {
      room.currentTurn = next;
      io.to(socket.roomId).emit('boardUpdate', {
        board: room.board, currentTurn: room.currentTurn,
        validMoves: nextMoves, lastMove: { row, col },
      });
    } else if (currentMoves.length > 0) {
      io.to(socket.roomId).emit('boardUpdate', {
        board: room.board, currentTurn: room.currentTurn,
        validMoves: currentMoves, lastMove: { row, col }, skipped: next,
      });
    } else {
      room.gameOver = true;
      const counts = countPieces(room.board);
      const winner = counts.B > counts.W ? 'B' : counts.W > counts.B ? 'W' : null;
      io.to(socket.roomId).emit('gameOver', {
        board: room.board, counts, winner, lastMove: { row, col },
      });
    }
  });

  // ── restartGame ──
  socket.on('restartGame', () => {
    const room = rooms.get(socket.roomId);
    // 12. 部屋のプレイヤーのみ再スタート可能
    if (!room || !room.players.some(p => p.id === socket.id)) return;
    room.board = createBoard();
    room.currentTurn = 'B';
    room.gameOver = false;
    resetRoomTimer(socket.roomId);
    io.to(socket.roomId).emit('gameStart', {
      board: room.board,
      currentTurn: room.currentTurn,
      validMoves: getValidMoves(room.board, room.currentTurn),
    });
  });

  // ── disconnect ──
  socket.on('disconnect', () => {
    ipSet.delete(socket.id);
    if (ipSet.size === 0) ipConnections.delete(ip);

    const room = rooms.get(socket.roomId);
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    io.to(socket.roomId).emit('opponentLeft');
    if (room.players.length === 0) {
      clearTimeout(room.timer);
      rooms.delete(socket.roomId);
    }
  });
});

// ── 未処理エラーで落とさない ──────────────────────────────────────────────
process.on('uncaughtException',  (err) => secLog('uncaught_exception', { msg: err.message }));
process.on('unhandledRejection', (err) => secLog('unhandled_rejection', { msg: String(err) }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => secLog('server_start', { port: PORT }));
