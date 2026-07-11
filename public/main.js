const socket = io();
let myColor = null;
const STARS = new Set(['2,2','2,5','5,2','5,5']);

// ── タイマー ──────────────────────────────────────────────────────────────
const TURN_SEC = 15;
let timerInterval = null;

function startClientTimer() {
  clearInterval(timerInterval);
  let sec = TURN_SEC;
  updateTimer(sec);
  document.getElementById('timer-wrap').style.display = 'flex';
  timerInterval = setInterval(() => {
    sec--;
    updateTimer(sec);
    if (sec <= 0) clearInterval(timerInterval);
  }, 1000);
}

function stopClientTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  document.getElementById('timer-wrap').style.display = 'none';
}

function updateTimer(sec) {
  const s = Math.max(0, sec);
  document.getElementById('timer-num').textContent = s;
  const bar = document.getElementById('timer-bar');
  bar.style.width = (s / TURN_SEC * 100) + '%';
  bar.style.background = s > 8 ? '#4caf50' : s > 4 ? '#ff9800' : '#f44336';
}

// ── ロビー ────────────────────────────────────────────────────────────────
document.getElementById('generateBtn').addEventListener('click', () => {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
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

// ── Socket イベント ───────────────────────────────────────────────────────
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
  hideResult();
  renderBoard(board, validMoves, null);
  updateScores(board);
  setTurnStatus(currentTurn, validMoves);
  document.getElementById('restartBtn').style.display = 'none';
  document.getElementById('messages').innerHTML = '';
  startClientTimer();
});

socket.on('boardUpdate', ({ board, currentTurn, validMoves, lastMove, skipped, timedOut }) => {
  renderBoard(board, validMoves, lastMove);
  updateScores(board);
  startClientTimer();

  if (timedOut) {
    const label = timedOut === 'B' ? '黒' : '白';
    addSysMessage(`${label}が時間切れ — ターン交代`);
    setTurnStatus(currentTurn, validMoves);
  } else if (skipped) {
    const passedLabel  = skipped     === 'B' ? '黒' : '白';
    const activeLabel  = currentTurn === 'B' ? '黒' : '白';
    showPassToast(`${passedLabel} はパス！\n${activeLabel} の番です`);
    addSysMessage(`${passedLabel}はパス — ${activeLabel}の番`);
    setTurnStatus(currentTurn, validMoves);
  } else {
    setTurnStatus(currentTurn, validMoves);
  }
});

socket.on('gameOver', ({ board, counts, winner, lastMove }) => {
  stopClientTimer();
  renderBoard(board, [], lastMove);
  updateScores(board);
  setStatus('ゲーム終了');
  showResult(winner, counts);
});

socket.on('opponentLeft', () => {
  stopClientTimer();
  setStatus('相手が切断しました。');
});
socket.on('roomExpired', () => {
  stopClientTimer();
  setStatus('部屋が30分経過のため終了しました。再度ルームに入ってください。');
});

document.getElementById('restartBtn').addEventListener('click', () => {
  socket.emit('restartGame');
  document.getElementById('restartBtn').style.display = 'none';
});

document.getElementById('result-close').addEventListener('click', () => {
  socket.emit('restartGame');
  hideResult();
});

// ── チャット ──────────────────────────────────────────────────────────────
document.getElementById('sendBtn').addEventListener('click', sendChat);
document.getElementById('chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
});

function sendChat() {
  const input = document.getElementById('chatInput');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('sendMessage', text);
  input.value = '';
}

socket.on('message', ({ color, text }) => {
  const label = color === 'B' ? '黒' : '白';
  addMessage(color, `${label}：${text}`);
});

function addMessage(colorClass, text) {
  const box = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = `msg ${colorClass}`;
  const who = document.createElement('span');
  who.className = 'who';
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function addSysMessage(text) {
  const box = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg sys';
  div.textContent = `— ${text} —`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

// ── 描画 ──────────────────────────────────────────────────────────────────
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

// ── 結果モーダル ──────────────────────────────────────────────────────────
function showResult(winner, counts) {
  const overlay = document.getElementById('result-overlay');
  const icon    = document.getElementById('result-icon');
  const title   = document.getElementById('result-title');
  const score   = document.getElementById('result-score');

  if (!winner) {
    icon.textContent  = '🤝';
    title.textContent = '引き分け！';
    title.style.color = '#e0c97f';
  } else if (winner === myColor) {
    icon.textContent  = '🏆';
    title.textContent = '勝利！';
    title.style.color = '#4caf50';
  } else {
    icon.textContent  = '😢';
    title.textContent = '敗北...';
    title.style.color = '#f44336';
  }
  score.textContent = `黒 ${counts.B} — ${counts.W} 白`;
  overlay.classList.add('show');
}

function hideResult() {
  document.getElementById('result-overlay').classList.remove('show');
}

// ── パストースト ──────────────────────────────────────────────────────────
let passToastTimer = null;
function showPassToast(msg) {
  const toast = document.getElementById('pass-toast');
  toast.textContent = msg;
  toast.style.display = 'block';
  clearTimeout(passToastTimer);
  passToastTimer = setTimeout(() => { toast.style.display = 'none'; }, 2000);
}
