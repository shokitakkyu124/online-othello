const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

function createBoard() {
  const board = Array(8).fill(null).map(() => Array(8).fill(null));
  board[3][3] = 'W';
  board[3][4] = 'B';
  board[4][3] = 'B';
  board[4][4] = 'W';
  return board;
}

const DIRECTIONS = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];

function getFlips(board, row, col, color) {
  const opponent = color === 'B' ? 'W' : 'B';
  const flips = [];
  for (const [dr, dc] of DIRECTIONS) {
    const line = [];
    let r = row + dr, c = col + dc;
    while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === opponent) {
      line.push([r, c]);
      r += dr;
      c += dc;
    }
    if (line.length > 0 && r >= 0 && r < 8 && c >= 0 && c < 8 && board[r][c] === color) {
      flips.push(...line);
    }
  }
  return flips;
}

function getValidMoves(board, color) {
  const moves = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (!board[r][c] && getFlips(board, r, c, color).length > 0) {
        moves.push([r, c]);
      }
    }
  }
  return moves;
}

function countPieces(board) {
  let B = 0, W = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell === 'B') B++;
      if (cell === 'W') W++;
    }
  }
  return { B, W };
}

io.on('connection', (socket) => {
  socket.on('joinRoom', (roomId) => {
    if (!rooms[roomId]) {
      rooms[roomId] = {
        board: createBoard(),
        players: [],
        currentTurn: 'B',
        gameOver: false,
      };
    }
    const room = rooms[roomId];
    if (room.players.length >= 2) {
      socket.emit('roomFull');
      return;
    }
    const color = room.players.length === 0 ? 'B' : 'W';
    room.players.push({ id: socket.id, color });
    socket.join(roomId);
    socket.roomId = roomId;
    socket.color = color;
    socket.emit('assignColor', color);

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

  socket.on('makeMove', ({ row, col }) => {
    const room = rooms[socket.roomId];
    if (!room || room.gameOver) return;
    if (room.currentTurn !== socket.color) return;

    const flips = getFlips(room.board, row, col, socket.color);
    if (flips.length === 0) return;

    room.board[row][col] = socket.color;
    for (const [r, c] of flips) room.board[r][c] = socket.color;

    const next = socket.color === 'B' ? 'W' : 'B';
    const nextMoves = getValidMoves(room.board, next);
    const currentMoves = getValidMoves(room.board, socket.color);

    if (nextMoves.length > 0) {
      room.currentTurn = next;
      io.to(socket.roomId).emit('boardUpdate', {
        board: room.board,
        currentTurn: room.currentTurn,
        validMoves: nextMoves,
        lastMove: { row, col },
      });
    } else if (currentMoves.length > 0) {
      io.to(socket.roomId).emit('boardUpdate', {
        board: room.board,
        currentTurn: room.currentTurn,
        validMoves: currentMoves,
        lastMove: { row, col },
        skipped: next,
      });
    } else {
      room.gameOver = true;
      const counts = countPieces(room.board);
      const winner = counts.B > counts.W ? 'B' : counts.W > counts.B ? 'W' : null;
      io.to(socket.roomId).emit('gameOver', { board: room.board, counts, winner, lastMove: { row, col } });
    }
  });

  socket.on('restartGame', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.board = createBoard();
    room.currentTurn = 'B';
    room.gameOver = false;
    io.to(socket.roomId).emit('gameStart', {
      board: room.board,
      currentTurn: room.currentTurn,
      validMoves: getValidMoves(room.board, room.currentTurn),
    });
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    room.players = room.players.filter(p => p.id !== socket.id);
    io.to(socket.roomId).emit('opponentLeft');
    if (room.players.length === 0) delete rooms[socket.roomId];
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
