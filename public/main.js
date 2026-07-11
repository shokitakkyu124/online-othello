const socket = io();
let myColor = null;

const STARS = new Set(['2,2','2,5','5,2','5,5']);

// ── ロビー ──
document.getElementById('generateBtn').addEventListener('click', () => {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  // 1000〜9999 にすることで先頭ゼロなしの確実な4桁を保証
  const id = String(1000 + (arr[0] % 9000));
  document.getElementById('roomInput').value = id;
});

document.getElementById('joinBtn').addEventListener('click', joinRoom);
document.getElementById('roomInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') joinRoom();
});

const ROOM_ID_PATTERN = /^\d{4}$/;
function joinRoom() {
  const roomId = document.getElementById('roomInput').value.trim();
  if (!ROOM_ID_PATTERN.test(roomId)) {
    setLobbyError('ルームIDは数字4桁で入力してください');
    return;
  }
  setLobbyError('');
  socket.emit('joinRoom', roomId);
}

function setLobbyError(msg) {
  document.getElementById('lobbyError').textContent = msg;
}

// ── Socket イベント ──
socket.on('assignColor', (color) => {
  myColor = color;
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  const badge = document.getElementById('colorBadge');
  badge.textContent = color === 'B' ? '● 黒（先手）' : '○ 白（後手）';
  badge.style.background = color === 'B' ? '#111' : '#eee';
  badge.style.color = color === 'B' ? '#eee' : '#111';
});

socket.on('waiting', () => {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game').style.display = 'block';
  setStatus('相手の接続を待っています...');
  renderBoard(createEmptyBoard(), [], null);
});

socket.on('roomFull', () => setLobbyError('そのルームは満員です。別のルームIDを試してください。'));
socket.on('secError', (msg) => setLobbyError(`⚠️ ${msg}`));

socket.on('gameStart', ({ board, currentTurn, validMoves }) => {
  renderBoard(board, validMoves, null);
  updateScores(board);
  setTurnStatus(currentTurn, validMoves);
  document.getElementById('restartBtn').style.display = 'none';
});

socket.on('boardUpdate', ({ board, currentTurn, validMoves, lastMove, skipped }) => {
  renderBoard(board, validMoves, lastMove);
  updateScores(board);
  if (skipped) {
    const label = skipped === 'B' ? '黒' : '白';
    setStatus(`${label}は置く場所がないためスキップ`);
    setTimeout(() => setTurnStatus(currentTurn, validMoves), 1500);
  } else {
    setTurnStatus(currentTurn, validMoves);
  }
});

socket.on('gameOver', ({ board, counts, winner, lastMove }) => {
  renderBoard(board, [], lastMove);
  updateScores(board);
  const msg = !winner ? '引き分けです！' : winner === myColor ? 'あなたの勝ちです！' : 'あなたの負けです...';
  setStatus(`ゲーム終了 — ${msg}`);
  document.getElementById('restartBtn').style.display = 'block';
});

socket.on('opponentLeft', () => setStatus('相手が切断しました。'));
socket.on('roomExpired', () => setStatus('部屋が30分経過のため終了しました。再度ルームに入ってください。'));

document.getElementById('restartBtn').addEventListener('click', () => {
  socket.emit('restartGame');
  document.getElementById('restartBtn').style.display = 'none';
});

// ── 描画 ──
function renderBoard(board, validMoves, lastMove) {
  const grid = document.getElementById('grid');
  grid.innerHTML = '';
  const validSet = new Set(validMoves.map(([r, c]) => `${r},${c}`));

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement('div');
      cell.className = 'cell';

      if (STARS.has(`${r},${c}`)) cell.classList.add('star');

      if (lastMove && lastMove.row === r && lastMove.col === c) {
        const marker = document.createElement('div');
        marker.className = 'last-marker';
        cell.appendChild(marker);
      }

      if (board[r][c]) {
        const disc = document.createElement('div');
        disc.className = `disc ${board[r][c] === 'B' ? 'black' : 'white'}`;
        cell.appendChild(disc);
      } else if (validSet.has(`${r},${c}`)) {
        cell.classList.add('valid');
        const hint = document.createElement('div');
        hint.className = 'hint-dot';
        cell.appendChild(hint);
        cell.addEventListener('click', () => socket.emit('makeMove', { row: r, col: c }));
      }

      grid.appendChild(cell);
    }
  }
}

function createEmptyBoard() {
  const b = Array(8).fill(null).map(() => Array(8).fill(null));
  b[3][3] = 'W'; b[3][4] = 'B'; b[4][3] = 'B'; b[4][4] = 'W';
  return b;
}

function updateScores(board) {
  let B = 0, W = 0;
  for (const row of board) for (const cell of row) { if (cell === 'B') B++; if (cell === 'W') W++; }
  document.getElementById('scoreB').textContent = B;
  document.getElementById('scoreW').textContent = W;
}

function setTurnStatus(turn, moves) {
  if (turn === myColor) setStatus(moves.length > 0 ? 'あなたの番です' : '置く場所がありません');
  else setStatus('相手の番です...');
}

function setStatus(msg) { document.getElementById('status').textContent = msg; }
