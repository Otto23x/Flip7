/**
 * Filotto — gioco di carte "push your luck" con carte da Scala 40.
 *
 * Contenuto:
 *  1. Costanti, impostazioni e stato
 *  2. Mazzo e punteggi
 *  3. Effetti sonori (solo brevi effetti, nessuna musica di fondo)
 *  4. Flusso di gioco (motore: gira solo in locale o sull'host online)
 *  5. CPU a tre livelli
 *  6. Rendering
 *  7. Navigazione e controlli
 *  8. Multiplayer online (relay WebSocket, host autoritativo)
 *  9. Statistiche
 * 10. Opzioni, toast e messaggi di gioco
 * 11. PWA (installazione, service worker, pull-to-refresh)
 */
'use strict';

/* =========================================================
   1. COSTANTI, IMPOSTAZIONI E STATO
   ========================================================= */
const APP_NAME = 'Filotto';
const LS = (key) => `filotto_${key}`;
const TARGET_OPTIONS = [101, 201, 301, 401, 501];
const DEFAULT_TARGET = 201;
const FILOTTO_SIZE = 7;
const FILOTTO_BONUS = 15;
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const DRAW_PACE_MS = 600;
const UNDO_LIMIT = 40;

const POWER_INFO = {
  FREEZE:     { icon: '❄️', label: 'GELO',       css: 'freeze' },
  DRAW_THREE: { icon: '🎲', label: 'PESCA 3',    css: 'draw3' },
  SHIELD:     { icon: '🛡️', label: 'SALVAGENTE', css: 'shield' },
  PEEK:       { icon: '👁️', label: 'SBIRCIA',    css: 'peek' },
  SWAP:       { icon: '🔄', label: 'SCAMBIO',    css: 'swap' },
  BANK:       { icon: '🏦', label: 'BANCA',      css: 'bank' }
};
const POWER_COUNTS = { FREEZE: 3, DRAW_THREE: 3, SHIELD: 3, PEEK: 3, SWAP: 2, BANK: 3 };
// Valore strategico stimato di ogni potere per la CPU (in "punti equivalenti").
const POWER_EV = { FREEZE: 4, DRAW_THREE: 2, SHIELD: 4, PEEK: 2.5, SWAP: 0, BANK: 3 };

const LEVEL_INFO = {
  easy:   { label: 'Facile',    tag: 'Prudente',    cpuName: 'CPU Timido',    desc: 'Si ferma presto, non conta le carte e ogni tanto sbaglia mossa. Ideale per imparare.' },
  normal: { label: 'Medio',     tag: 'Calcolatore', cpuName: 'CPU Contabile', desc: 'Calcola rischio e guadagno di ogni pescata sulle carte rimaste, ma ignora il tuo punteggio.' },
  hard:   { label: 'Difficile', tag: 'Stratega',    cpuName: 'CPU Stratega',  desc: 'Conta le carte, sfrutta ogni potere e gioca in base al tuo punteggio e al traguardo.' },
  online: { label: 'Online',    tag: 'Multiplayer', cpuName: '',              desc: '' }
};

const settings = {
  soundEnabled: true,
  serverUrl: '',
  playerName: 'Giocatore',
  level: 'normal',
  target: DEFAULT_TARGET
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS('settings'));
    if (raw) Object.assign(settings, JSON.parse(raw));
  } catch (e) { /* ignora */ }
  if (!TARGET_OPTIONS.includes(settings.target)) settings.target = DEFAULT_TARGET;
  if (!LEVEL_INFO[settings.level] || settings.level === 'online') settings.level = 'normal';
  if (typeof settings.playerName !== 'string' || !settings.playerName.trim()) settings.playerName = 'Giocatore';
}
function saveSettings() {
  try { localStorage.setItem(LS('settings'), JSON.stringify(settings)); } catch (e) { /* ignora */ }
}

function freshState() {
  return {
    drawPile: [],
    discardPile: [],
    usedCards: [],
    players: [],
    currentPlayerIndex: 0,
    dealerIndex: 0,
    roundNumber: 1,
    phase: 'SETUP', // SETUP | TURN | ROUND_END | GAME_END
    winnerId: null,
    mode: 'normal', // easy | normal | hard | online
    targetScore: DEFAULT_TARGET,
    peek: null,          // { playerId, cardId }: la prossima carta del mazzo è nota a quel giocatore
    localPlayerId: 'p1', // chi gioca su questo dispositivo (p1 = solo/host, p2 = ospite online)
    config: null,        // configurazione dell'ultima partita (per la rivincita)
    undoStack: [],
    isCpuBusy: false,
    forcedBusy: false,   // pescate forzate (Pesca 3) in corso: i pulsanti restano bloccati
    remote: { deckCount: 0, peekCard: null } // specchio dei dati dell'host, usato solo dall'ospite
  };
}

let state = freshState();
let sequenceToken = 0;
let deferredAndroidPrompt = null;

function makePlayer(id, name, controller) {
  return {
    id, name, controller, // controller: 'local' | 'cpu' | 'remote'
    score: 0, roundScore: 0, status: 'ACTIVE', // ACTIVE | STAYED | BUSTED | FROZEN | FILOTTO
    valueCards: [], modifierCards: [], shieldCard: null, usedPowerCards: [], bustCard: null,
    bankedScore: 0
  };
}

/* =========================================================
   2. MAZZO E PUNTEGGI
   ========================================================= */
function rankValue(rank) {
  if (rank === 'A') return 1;
  if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
  return parseInt(rank, 10);
}

// 2 mazzi da Scala 40 (104 carte) + 4 jolly + 7 modificatori + 17 carte potere = 132 carte.
function createDeck() {
  const deck = [];
  let n = 1;
  for (let d = 0; d < 2; d++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) deck.push({ id: `v${n++}`, type: 'VALUE', rank, suit, value: rankValue(rank) });
    }
  }
  for (let i = 0; i < 4; i++) deck.push({ id: `w${n++}`, type: 'VALUE', rank: '★', suit: '', value: 0, joker: true });
  [2, 4, 6, 8, 10].forEach(v => deck.push({ id: `m${n++}`, type: 'MODIFIER', effect: 'PLUS', value: v }));
  for (let i = 0; i < 2; i++) deck.push({ id: `m${n++}`, type: 'MODIFIER', effect: 'DOUBLE' });
  Object.entries(POWER_COUNTS).forEach(([effect, count]) => {
    for (let i = 0; i < count; i++) deck.push({ id: `p${n++}`, type: 'POWER', effect });
  });
  return deck;
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Carte "diverse": ogni rango conta una volta sola, ogni jolly conta sempre come carta unica.
function uniqueCount(player) {
  const ranks = new Set();
  let jokers = 0;
  for (const c of player.valueCards) {
    if (c.joker) jokers++; else ranks.add(c.rank);
  }
  return ranks.size + jokers;
}

function sumValues(player) {
  return player.valueCards.reduce((s, c) => s + c.value, 0);
}

function calculateRoundScore(player) {
  if (player.status === 'BUSTED') return { score: player.bankedScore || 0, isFilotto: false };
  const isFilotto = uniqueCount(player) >= FILOTTO_SIZE;
  const hasDouble = player.modifierCards.some(c => c.effect === 'DOUBLE');
  const plusTotal = player.modifierCards.filter(c => c.effect === 'PLUS').reduce((s, c) => s + c.value, 0);
  let total = sumValues(player) * (hasDouble ? 2 : 1) + plusTotal;
  if (isFilotto) total += FILOTTO_BONUS;
  return { score: total, isFilotto };
}

function rebuildDeckIfNeeded() {
  if (state.drawPile.length > 0) return;
  const onTable = new Set();
  for (const p of state.players) {
    p.valueCards.forEach(c => onTable.add(c.id));
    p.modifierCards.forEach(c => onTable.add(c.id));
    p.usedPowerCards.forEach(c => onTable.add(c.id));
    if (p.shieldCard) onTable.add(p.shieldCard.id);
    if (p.bustCard) onTable.add(p.bustCard.id);
  }
  const toShuffle = [...state.discardPile, ...state.usedCards].filter(c => !onTable.has(c.id));
  state.drawPile = shuffle(toShuffle);
  state.discardPile = [];
  state.usedCards = state.usedCards.filter(c => onTable.has(c.id));
}

function deckCount() {
  return isGuest() ? state.remote.deckCount : state.drawPile.length;
}

// La carta in cima al mazzo, se il giocatore indicato l'ha sbirciata ed è ancora lì.
function peekCardFor(playerId) {
  if (isGuest()) return playerId === state.localPlayerId ? state.remote.peekCard : null;
  if (!state.peek || state.peek.playerId !== playerId) return null;
  const top = state.drawPile[0];
  return top && top.id === state.peek.cardId ? top : null;
}

function cardCausesBust(player, card) {
  return card.type === 'VALUE' && !card.joker && player.valueCards.some(c => !c.joker && c.rank === card.rank);
}

/* =========================================================
   3. EFFETTI SONORI (brevi, sintetizzati: niente musica di fondo)
   ========================================================= */
let audioCtx = null;

function initAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

function tone(type, freqFrom, freqTo, duration, volume, startAt) {
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  const t = startAt !== undefined ? startAt : audioCtx.currentTime;
  osc.type = type;
  osc.frequency.setValueAtTime(freqFrom, t);
  if (freqTo && freqTo !== freqFrom) osc.frequency.exponentialRampToValueAtTime(freqTo, t + duration);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(volume, t + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

function playSfxLocal(name) {
  if (!settings.soundEnabled) return;
  initAudio();
  if (!audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    switch (name) {
      case 'draw': tone('triangle', 520, 720, 0.12, 0.12); break;
      case 'stay': tone('sine', 392, 392, 0.12, 0.13); tone('sine', 523.25, 523.25, 0.3, 0.13, now + 0.1); break;
      case 'bust': tone('sawtooth', 220, 50, 0.5, 0.25); break;
      case 'power': tone('square', 660, 880, 0.08, 0.06); tone('square', 880, 1100, 0.12, 0.06, now + 0.08); break;
      case 'win': [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone('triangle', f, f, 0.4, 0.15, now + i * 0.09)); break;
      default: break;
    }
  } catch (e) { /* audio best-effort */ }
}

// Suona in locale e, se siamo l'host di una partita online, fa suonare anche l'ospite.
function sfx(name) {
  playSfxLocal(name);
  if (isHost()) relay({ k: 'sfx', name });
}

/* =========================================================
   4. FLUSSO DI GIOCO (motore: locale o host online)
   ========================================================= */
function bumpSequence() { sequenceToken++; return sequenceToken; }
function isStale(token) { return token !== sequenceToken; }

function localPlayer() { return state.players.find(p => p.id === state.localPlayerId) || null; }
function getOpponent(player) { return state.players.find(p => p.id !== player.id) || null; }
function currentPlayer() { return state.players[state.currentPlayerIndex] || null; }

// config: { mode, targetScore, players: [{ id, name, controller }] }
function startNewGame(config) {
  initAudio();
  bumpSequence();
  const keepRemote = state.remote;
  state = freshState();
  state.remote = keepRemote;
  state.config = config;
  state.mode = config.mode;
  state.targetScore = TARGET_OPTIONS.includes(config.targetScore) ? config.targetScore : DEFAULT_TARGET;
  state.localPlayerId = 'p1';
  state.players = config.players.map(p => makePlayer(p.id, p.name, p.controller));
  state.drawPile = shuffle(createDeck());
  closeAllDialogs();
  navigateScreen('screen-game');
  startRound();
}

function startSoloGame() {
  const name = readNameInput('p1-name-input');
  settings.playerName = name;
  saveSettings();
  const level = settings.level;
  startNewGame({
    mode: level,
    targetScore: settings.target,
    players: [
      { id: 'p1', name, controller: 'local' },
      { id: 'p2', name: LEVEL_INFO[level].cpuName, controller: 'cpu' }
    ]
  });
}

function startRound() {
  bumpSequence();
  state.isCpuBusy = false;
  state.forcedBusy = false;
  state.peek = null;
  setThinking(false);
  state.players.forEach(p => {
    p.roundScore = 0;
    p.status = 'ACTIVE';
    p.valueCards = [];
    p.modifierCards = [];
    p.shieldCard = null;
    p.usedPowerCards = [];
    p.bustCard = null;
    p.bankedScore = 0;
  });
  state.discardPile = [...state.discardPile, ...state.usedCards];
  state.usedCards = [];
  state.undoStack = [];
  rebuildDeckIfNeeded();

  state.currentPlayerIndex = (state.dealerIndex + 1) % state.players.length;
  state.phase = 'TURN';
  afterTurnChange();
}

function afterTurnChange() {
  renderGame();
  triggerCpuTurnIfNeeded();
}

function finishHandBecauseDeckIsEmpty() {
  showGameMessage('🂠 Mazzo esaurito: la mano finisce qui.');
  state.players.forEach(p => {
    if (p.status === 'ACTIVE') {
      p.status = 'STAYED';
      p.roundScore = calculateRoundScore(p).score;
    }
  });
  endRound();
}

function takeTopCard() {
  const card = state.drawPile.shift();
  state.usedCards.push(card);
  if (state.peek && state.peek.cardId === card.id) state.peek = null;
  return card;
}

function drawCard(playerIndex) {
  const player = state.players[playerIndex];
  if (!player || player.status !== 'ACTIVE') return;

  rebuildDeckIfNeeded();
  if (state.drawPile.length === 0) { finishHandBecauseDeckIsEmpty(); return; }

  snapshotForUndo();
  sfx('draw');
  const card = takeTopCard();
  const extraDraws = applyCardEffect(playerIndex, card);

  if (player.status === 'FILOTTO') { endRound(); return; }
  if (player.status === 'BUSTED') { checkTurnOrRoundEnd(); return; }

  if (extraDraws.length > 0) {
    // Pesca 3 all'avversario: il turno torna a chi l'ha pescata quando le pescate forzate finiscono.
    state.forcedBusy = true;
    const token = sequenceToken;
    renderGame();
    setTimeout(() => {
      if (isStale(token)) return;
      processForcedDrawQueue(extraDraws, player.id, token);
    }, DRAW_PACE_MS);
  } else if (card.type === 'POWER' && card.effect === 'PEEK' && state.peek && state.peek.playerId === player.id) {
    // Sbircia: il turno non passa, chi l'ha pescata decide subito sapendo cosa c'è in cima al mazzo.
    afterTurnChange();
  } else {
    checkTurnOrRoundEnd();
  }
}

function snapshotForUndo() {
  if (state.mode === 'online') return;
  state.undoStack.push({
    players: JSON.parse(JSON.stringify(state.players)),
    drawPile: state.drawPile.slice(),
    discardPile: state.discardPile.slice(),
    usedCards: state.usedCards.slice(),
    peek: state.peek ? { ...state.peek } : null,
    currentPlayerIndex: state.currentPlayerIndex,
    dealerIndex: state.dealerIndex,
    roundNumber: state.roundNumber,
    phase: state.phase
  });
  if (state.undoStack.length > UNDO_LIMIT) state.undoStack.shift();
}

// Applica l'effetto immediato di una carta e mostra un messaggio. Restituisce gli indici dei
// giocatori a cui è dovuta una pescata forzata (solo PESCA 3). Non decide mai cosa succede
// al turno dopo: ci pensano drawCard / processForcedDrawQueue.
//
// Le carte penalità (GELO, PESCA 3, SCAMBIO) non si scelgono: vanno sempre all'avversario.
// Se l'avversario non è più attivo non c'è nessuno da colpire e la carta viene scartata.
function applyCardEffect(playerIndex, card) {
  const player = state.players[playerIndex];
  const who = player.name;
  const opponent = getOpponent(player);
  const oppActive = opponent && opponent.status === 'ACTIVE';

  if (card.type === 'VALUE') {
    if (cardCausesBust(player, card)) {
      if (player.shieldCard) {
        showGameMessage(`🛡️ ${who} pesca un altro ${card.rank} ma il Salvagente lo salva dal Doppione!`);
        state.discardPile.push(card, player.shieldCard);
        player.shieldCard = null;
        sfx('power');
      } else {
        sfx('bust');
        player.bustCard = card; // resta visibile accanto all'originale, così è chiaro perché è un Doppione
        player.status = 'BUSTED';
        player.roundScore = player.bankedScore || 0;
        showGameMessage(player.bankedScore > 0
          ? `💥 ${who} pesca un altro ${card.rank}: DOPPIONE! Tiene solo i ${player.bankedScore} punti in Banca.`
          : `💥 ${who} pesca un altro ${card.rank}: DOPPIONE! Mano azzerata.`);
      }
      return [];
    }
    player.valueCards.push(card);
    const res = calculateRoundScore(player);
    player.roundScore = res.score;
    if (res.isFilotto) {
      showGameMessage(`🌟 FILOTTO! ${who} ha ${FILOTTO_SIZE} carte diverse: +${FILOTTO_BONUS} punti e mano chiusa!`);
      sfx('win');
      player.status = 'FILOTTO';
    } else if (card.joker) {
      showGameMessage(`🃏 ${who} pesca un JOLLY: vale 0 ma conta come carta diversa e non fa mai Doppione.`);
    }
    return [];
  }

  if (card.type === 'MODIFIER') {
    player.modifierCards.push(card);
    player.roundScore = calculateRoundScore(player).score;
    sfx('power');
    if (card.effect === 'DOUBLE') {
      showGameMessage(player.modifierCards.filter(c => c.effect === 'DOUBLE').length > 1
        ? `✖️ ${who} pesca un altro ×2: il raddoppio non si cumula, la carta non aggiunge nulla.`
        : `✖️ ${who} pesca ×2: raddoppia la somma delle carte.`);
    } else {
      showGameMessage(`➕ ${who} pesca +${card.value}: ${card.value} punti fissi in più.`);
    }
    return [];
  }

  // POWER
  sfx('power');
  switch (card.effect) {
    case 'SHIELD': {
      if (!player.shieldCard) {
        player.shieldCard = card;
        showGameMessage(`🛡️ ${who} pesca il Salvagente: annulla un Doppione, poi si scarta.`);
      } else if (oppActive && !opponent.shieldCard) {
        opponent.shieldCard = card;
        showGameMessage(`🛡️ ${who} ne aveva già uno: il Salvagente passa a ${opponent.name}.`);
      } else {
        state.discardPile.push(card);
        showGameMessage(`🛡️ ${who} pesca un Salvagente ma nessuno può prenderlo: scartato.`);
      }
      return [];
    }
    case 'FREEZE': {
      if (!oppActive) {
        state.discardPile.push(card);
        showGameMessage(`❄️ ${who} pesca GELO, ma l'avversario ha già chiuso: scartata.`);
        return [];
      }
      player.usedPowerCards.push(card);
      opponent.status = 'FROZEN';
      opponent.roundScore = calculateRoundScore(opponent).score;
      showGameMessage(`❄️ ${who} pesca GELO: ${opponent.name} è congelato e chiude la mano con ${opponent.roundScore} punti.`);
      return [];
    }
    case 'DRAW_THREE': {
      if (!oppActive) {
        state.discardPile.push(card);
        showGameMessage(`🎲 ${who} pesca PESCA 3, ma l'avversario ha già chiuso: scartata.`);
        return [];
      }
      player.usedPowerCards.push(card);
      showGameMessage(`🎲 ${who} pesca PESCA 3: ${opponent.name} deve pescare 3 carte di fila!`);
      const targetIdx = state.players.findIndex(p => p.id === opponent.id);
      return [targetIdx, targetIdx, targetIdx];
    }
    case 'PEEK': {
      player.usedPowerCards.push(card);
      rebuildDeckIfNeeded();
      if (state.drawPile.length > 0) {
        state.peek = { playerId: player.id, cardId: state.drawPile[0].id };
        showGameMessage(player.controller === 'local'
          ? '👁️ SBIRCIA: la prossima carta del mazzo è scoperta solo per te.'
          : `👁️ ${who} pesca SBIRCIA e guarda la prossima carta del mazzo.`);
      } else {
        showGameMessage(`👁️ ${who} pesca SBIRCIA, ma il mazzo è vuoto.`);
      }
      return [];
    }
    case 'SWAP': {
      if (!oppActive) {
        state.discardPile.push(card);
        showGameMessage(`🔄 ${who} pesca SCAMBIO, ma l'avversario ha già chiuso: scartata.`);
        return [];
      }
      player.usedPowerCards.push(card);
      const mine = player.valueCards;
      player.valueCards = opponent.valueCards;
      opponent.valueCards = mine;
      player.roundScore = calculateRoundScore(player).score;
      opponent.roundScore = calculateRoundScore(opponent).score;
      showGameMessage(`🔄 ${who} pesca SCAMBIO: le carte valore passano di mano tra i due giocatori!`);
      return [];
    }
    case 'BANK': {
      player.usedPowerCards.push(card);
      const safe = calculateRoundScore(player).score;
      player.bankedScore = Math.max(player.bankedScore || 0, safe);
      showGameMessage(safe > 0
        ? `🏦 ${who} pesca BANCA: ${safe} punti al sicuro anche in caso di Doppione.`
        : `🏦 ${who} pesca BANCA, ma non ha ancora punti da mettere al sicuro.`);
      return [];
    }
    default:
      state.discardPile.push(card);
      return [];
  }
}

function returnTurnToSource(sourcePlayer) {
  state.forcedBusy = false;
  if (sourcePlayer.status !== 'ACTIVE') { checkTurnOrRoundEnd(); return; }
  state.currentPlayerIndex = state.players.findIndex(p => p.id === sourcePlayer.id);
  state.phase = 'TURN';
  afterTurnChange();
}

// Una pescata forzata alla volta. Se una pescata forzata è a sua volta una PESCA 3, le sue 3
// pescate vengono messe in testa alla coda, così un annidamento a qualsiasi profondità si
// risolve da solo. Le pescate dovute a un giocatore non più attivo vengono semplicemente saltate.
function processForcedDrawQueue(queue, returnToPlayerId, token) {
  if (isStale(token)) return;
  const remaining = queue.filter(idx => state.players[idx].status === 'ACTIVE');

  if (remaining.length === 0) {
    const source = state.players.find(p => p.id === returnToPlayerId);
    if (source) returnTurnToSource(source);
    else { state.forcedBusy = false; checkTurnOrRoundEnd(); }
    return;
  }

  const targetIdx = remaining[0];
  const rest = remaining.slice(1);
  const target = state.players[targetIdx];

  rebuildDeckIfNeeded();
  if (state.drawPile.length === 0) { state.forcedBusy = false; finishHandBecauseDeckIsEmpty(); return; }

  sfx('draw');
  const card = takeTopCard();
  const extraDraws = applyCardEffect(targetIdx, card);
  if (target.status === 'FILOTTO') { state.forcedBusy = false; endRound(); return; }

  renderGame();
  const nextQueue = extraDraws.concat(rest);
  setTimeout(() => {
    if (isStale(token)) return;
    processForcedDrawQueue(nextQueue, returnToPlayerId, token);
  }, DRAW_PACE_MS);
}

function playerStay(playerIndex) {
  const player = state.players[playerIndex];
  if (!player || player.status !== 'ACTIVE') return;
  snapshotForUndo();
  sfx('stay');
  player.status = 'STAYED';
  player.roundScore = calculateRoundScore(player).score;
  showGameMessage(`✋ ${player.name} si ferma con ${player.roundScore} punti.`);
  checkTurnOrRoundEnd();
}

function checkTurnOrRoundEnd() {
  state.forcedBusy = false;
  const active = state.players.filter(p => p.status === 'ACTIVE');
  if (active.length === 0) { endRound(); return; }

  let next = (state.currentPlayerIndex + 1) % state.players.length;
  let guard = 0;
  while (state.players[next].status !== 'ACTIVE' && guard < state.players.length) {
    next = (next + 1) % state.players.length;
    guard++;
  }
  state.currentPlayerIndex = next;
  state.phase = 'TURN';
  afterTurnChange();
}

function endRound() {
  state.forcedBusy = false;
  state.isCpuBusy = false;
  setThinking(false);
  const gains = {};
  state.players.forEach(p => {
    const res = calculateRoundScore(p); // per chi ha fatto Doppione restituisce i punti in Banca (o 0)
    p.roundScore = res.score;
    p.score += res.score;
    gains[p.id] = res.score;
  });
  state.phase = 'ROUND_END';
  renderGame();
  if (!checkGameOver()) showRoundEndModal(gains);
}

function checkGameOver() {
  const reached = state.players.filter(p => p.score >= state.targetScore);
  if (reached.length === 0) return false;
  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  if (sorted[0].score === sorted[1].score) return false; // parità sopra il traguardo: si continua
  const winner = sorted[0];
  state.phase = 'GAME_END';
  state.winnerId = winner.id;
  renderGame();
  saveGameStats(winner.id === state.localPlayerId ? 'win' : 'loss');
  showGameEndModal(winner);
  if (isHost()) relay({ k: 'gameEnd', winnerId: winner.id });
  return true;
}

function proceedToNextRound() {
  if (state.phase !== 'ROUND_END') return;
  state.dealerIndex = (state.dealerIndex + 1) % state.players.length;
  state.roundNumber += 1;
  startRound();
}

/* =========================================================
   5. CPU A TRE LIVELLI
   ========================================================= */
function computeHitStats(player) {
  const remaining = state.drawPile.length > 0 ? state.drawPile : [...state.discardPile, ...state.usedCards];
  const total = remaining.length;
  if (total === 0) return { bustProb: 0, avgGainIfSafe: 4, safeValueShare: 1, total: 0 };

  const held = new Set(player.valueCards.filter(c => !c.joker).map(c => c.rank));
  let danger = 0, safe = 0, safeSum = 0, safeValue = 0;
  const currentSum = sumValues(player);
  const hasDouble = player.modifierCards.some(c => c.effect === 'DOUBLE');

  for (const c of remaining) {
    if (c.type === 'VALUE') {
      if (!c.joker && held.has(c.rank)) danger++;
      else { safe++; safeValue++; safeSum += c.value * (hasDouble ? 2 : 1); }
    } else if (c.type === 'MODIFIER') {
      safe++;
      safeSum += c.effect === 'DOUBLE' ? (hasDouble ? 0 : Math.max(4, currentSum)) : c.value;
    } else {
      safe++;
      safeSum += POWER_EV[c.effect] || 1;
    }
  }
  return {
    bustProb: danger / total,
    avgGainIfSafe: safe > 0 ? safeSum / safe : 0,
    safeValueShare: safe > 0 ? safeValue / safe : 0,
    total
  };
}

// Stima "a occhio" senza contare le carte: 8 copie per rango su 132 carte, ignora le carte già uscite.
function naiveBustProb(player) {
  const ranks = new Set(player.valueCards.filter(c => !c.joker).map(c => c.rank)).size;
  return Math.min(0.95, (ranks * 8) / 132);
}

function peekIsSafe(player, card) {
  return !cardCausesBust(player, card);
}

// FACILE — Prudente: si ferma presto, stima il rischio a occhio, usa la sbirciata solo a volte
// e ogni tanto sbaglia. Non guarda mai l'avversario.
function chooseEasy(me, peekCard) {
  const rs = calculateRoundScore(me).score;
  if (rs === 0) return 'HIT';
  if (me.score + rs >= state.targetScore && Math.random() < 0.7) return 'STAY';
  if (peekCard && Math.random() < 0.5) return peekIsSafe(me, peekCard) ? 'HIT' : 'STAY';

  const comfort = 16 + Math.floor(Math.random() * 10); // si accontenta di 16–25 punti
  let action = (rs >= comfort || naiveBustProb(me) > 0.38) ? 'STAY' : 'HIT';
  if (Math.random() < 0.15) action = action === 'HIT' ? 'STAY' : 'HIT'; // errore casuale
  return action;
}

// MEDIO — Calcolatore: valore atteso sulle carte davvero rimaste nel mazzo, usa Salvagente e
// Sbircia, prova a chiudere il Filotto. Ignora il punteggio dell'avversario.
function chooseNormal(me, peekCard) {
  const rs = calculateRoundScore(me).score;
  if (me.score + rs >= state.targetScore) return 'STAY';
  if (peekCard) return (peekIsSafe(me, peekCard) || me.shieldCard) ? 'HIT' : 'STAY';

  const { bustProb, avgGainIfSafe } = computeHitStats(me);
  if (me.shieldCard && bustProb < 0.5) return 'HIT';
  if (uniqueCount(me) >= FILOTTO_SIZE - 1 && bustProb < 0.5) return 'HIT';
  const evGain = (1 - bustProb) * avgGainIfSafe;
  const evLoss = bustProb * rs;
  return evGain > evLoss ? 'HIT' : 'STAY';
}

// DIFFICILE — Stratega: come il Medio ma conosce la Banca (rischia solo i punti non al sicuro),
// legge la situazione dell'avversario (se ha già chiuso con più punti deve superarlo, se
// vincerebbe la partita è obbligato a rischiare), modula l'aggressività sul distacco e sul
// traguardo e valuta il bonus Filotto.
function chooseHard(me, opp, peekCard) {
  const target = state.targetScore;
  const myRound = calculateRoundScore(me).score;
  const myTotal = me.score + myRound;
  const oppFinished = opp.status !== 'ACTIVE';
  const oppRound = oppFinished ? opp.roundScore : calculateRoundScore(opp).score;
  const oppTotal = opp.score + oppRound;
  const stats = computeHitStats(me);

  let bustProb = stats.bustProb;
  if (peekCard) bustProb = peekIsSafe(me, peekCard) ? 0 : 1;
  if (me.shieldCard) bustProb *= 0.15; // il Salvagente assorbe il primo Doppione

  // Chiudo se fermandomi vinco la partita.
  if (myTotal >= target && myTotal > oppTotal) return 'STAY';
  // L'avversario ha già chiuso e vincerebbe: fermarmi ora significa perdere, devo superarlo.
  if (oppFinished && oppTotal >= target && myTotal <= oppTotal) return 'HIT';

  const atRisk = Math.max(0, myRound - (me.bankedScore || 0));
  let gain = (1 - bustProb) * stats.avgGainIfSafe;
  if (uniqueCount(me) === FILOTTO_SIZE - 1) gain += (1 - bustProb) * stats.safeValueShare * FILOTTO_BONUS;
  const loss = bustProb * atRisk;

  let risk = 1;
  const diff = me.score - opp.score;
  if (diff < -40) risk = 1.35;
  else if (diff < -15) risk = 1.15;
  else if (diff > 40) risk = 0.8;
  else if (diff > 15) risk = 0.9;
  if (oppFinished && oppRound > myRound) risk *= 1.2;        // devo recuperare in questa mano
  if (oppFinished && oppRound <= myRound && myRound > 0) risk *= 0.85; // sono già avanti: proteggo
  const oppNearWin = target - oppTotal <= 25;
  if (oppNearWin && myTotal < oppTotal) risk *= 1.15;        // la partita sta per finire: spingo

  return gain * risk > loss ? 'HIT' : 'STAY';
}

function chooseCpuAction(playerIndex, level) {
  const me = state.players[playerIndex];
  const opp = getOpponent(me);
  const peekCard = peekCardFor(me.id);
  if (level === 'easy') return chooseEasy(me, peekCard);
  if (level === 'normal') return chooseNormal(me, peekCard);
  return chooseHard(me, opp, peekCard);
}

function triggerCpuTurnIfNeeded() {
  if (state.phase !== 'TURN' || state.forcedBusy) return;
  const idx = state.currentPlayerIndex;
  const cpu = state.players[idx];
  if (!cpu || cpu.controller !== 'cpu') return;
  if (cpu.status !== 'ACTIVE') { checkTurnOrRoundEnd(); return; }

  state.isCpuBusy = true;
  setThinking(true);
  const token = sequenceToken;
  const base = state.mode === 'hard' ? 700 : (state.mode === 'normal' ? 600 : 450);
  const delay = base + Math.floor(Math.random() * 500);
  setTimeout(() => {
    if (isStale(token)) return;
    state.isCpuBusy = false;
    setThinking(false);
    if (state.phase !== 'TURN' || state.currentPlayerIndex !== idx || cpu.status !== 'ACTIVE') { renderGame(); return; }
    const action = chooseCpuAction(idx, state.mode);
    if (action === 'HIT') drawCard(idx); else playerStay(idx);
  }, delay);
}

/* =========================================================
   6. RENDERING
   ========================================================= */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function createCardEl(card, extraClass) {
  const el = document.createElement('div');
  el.className = 'pcard ' + (extraClass || '');
  if (card.type === 'VALUE') {
    if (card.joker) {
      el.classList.add('joker');
      el.innerHTML = '<span class="big">★</span><span class="lbl">JOLLY</span>';
    } else {
      el.classList.add(card.suit === '♥' || card.suit === '♦' ? 'red' : 'black');
      el.innerHTML = `<span class="rk">${card.rank}<i>${card.suit}</i></span><span class="st">${card.suit}</span><span class="rk rk-b">${card.rank}<i>${card.suit}</i></span>`;
    }
    el.title = card.joker ? 'Jolly: vale 0, conta come carta diversa' : `${card.rank}${card.suit} = ${card.value} punti`;
  } else if (card.type === 'MODIFIER') {
    el.classList.add('mod');
    el.innerHTML = `<span class="big">${card.effect === 'DOUBLE' ? '×2' : '+' + card.value}</span><span class="lbl">${card.effect === 'DOUBLE' ? 'RADDOPPIA' : 'BONUS'}</span>`;
  } else {
    const info = POWER_INFO[card.effect];
    el.classList.add('power', 'pw-' + info.css);
    el.innerHTML = `<span class="big">${info.icon}</span><span class="lbl">${info.label}</span>`;
  }
  return el;
}

function renderStatusBadge(el, player) {
  el.className = 'badge-status ';
  switch (player.status) {
    case 'ACTIVE': el.classList.add('status-active'); el.textContent = 'IN GIOCO'; break;
    case 'STAYED': el.classList.add('status-stayed'); el.textContent = `FERMO · ${player.roundScore} pt`; break;
    case 'BUSTED': el.classList.add('status-busted'); el.textContent = `DOPPIONE · ${player.roundScore} pt`; break;
    case 'FROZEN': el.classList.add('status-frozen'); el.textContent = `GELO · ${player.roundScore} pt`; break;
    case 'FILOTTO': el.classList.add('status-filotto'); el.textContent = '🌟 FILOTTO'; break;
    default: break;
  }
}

function renderPlayerZone(player, prefix, isActiveTurn, inRound) {
  document.getElementById(`${prefix}-name`).textContent = player.name;
  document.getElementById(`${prefix}-total`).textContent = player.score;
  document.getElementById(`${prefix}-round-score`).textContent = player.roundScore;
  document.getElementById(`${prefix}-unique`).textContent = uniqueCount(player);
  renderStatusBadge(document.getElementById(`${prefix}-status-badge`), player);

  const bank = document.getElementById(`${prefix}-bank`);
  if (player.bankedScore > 0) { bank.style.display = 'inline-flex'; bank.textContent = `🏦 ${player.bankedScore}`; }
  else bank.style.display = 'none';

  const box = document.getElementById(`${prefix}-cards`);
  box.innerHTML = '';
  player.valueCards.forEach(c => box.appendChild(createCardEl(c)));
  if (player.bustCard) box.appendChild(createCardEl(player.bustCard, 'bust-dup'));
  player.modifierCards.forEach(c => box.appendChild(createCardEl(c)));
  if (player.shieldCard) box.appendChild(createCardEl(player.shieldCard));
  player.usedPowerCards.forEach(c => box.appendChild(createCardEl(c, 'spent')));

  const zone = document.getElementById(`${prefix}-zone`);
  zone.classList.toggle('active-turn', inRound && isActiveTurn);
  zone.classList.toggle('inactive-turn', inRound && !isActiveTurn);
  zone.classList.toggle('is-busted', player.status === 'BUSTED');
}

function setThinking(active) {
  const el = document.getElementById('status-thinking-dots');
  if (el) el.style.display = active ? 'flex' : 'none';
}

function renderGame() {
  const me = localPlayer();
  const opp = me ? getOpponent(me) : null;
  if (!me || !opp) return;

  const inRound = state.phase === 'TURN';
  const current = currentPlayer();
  const myTurn = inRound && !!current && current.id === me.id;

  document.getElementById('status-right').innerHTML =
    `🎯 <strong>${state.targetScore}</strong> · Mazzo <strong>${deckCount()}</strong>`;
  document.getElementById('opp-avatar').textContent = opp.controller === 'cpu' ? '🤖' : '🧑‍🤝‍🧑';

  renderPlayerZone(me, 'me', myTurn, inRound);
  renderPlayerZone(opp, 'opp', inRound && !myTurn, inRound);

  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (inRound && current) {
    dot.style.background = myTurn ? 'var(--accent)' : 'var(--purple)';
    text.textContent = `Mano ${state.roundNumber} · tocca a ${myTurn ? 'te' : current.name}`;
  } else if (state.phase === 'ROUND_END') {
    dot.style.background = 'var(--blue)';
    text.textContent = `Fine mano ${state.roundNumber}`;
  } else if (state.phase === 'GAME_END') {
    dot.style.background = 'var(--accent)';
    text.textContent = 'Partita finita';
  }
  if (!isGuest()) setThinking(state.isCpuBusy || state.forcedBusy);
  else setThinking(inRound && !myTurn);

  // Carta sbirciata (visibile solo a chi ha pescato SBIRCIA)
  const peekBox = document.getElementById('peek-box');
  const peekCard = inRound ? peekCardFor(me.id) : null;
  if (peekCard) {
    peekBox.style.display = 'flex';
    const slot = document.getElementById('peek-card');
    slot.innerHTML = '';
    slot.appendChild(createCardEl(peekCard, 'mini'));
    document.getElementById('peek-hint').textContent = cardCausesBust(me, peekCard)
      ? (me.shieldCard ? 'Sarebbe un Doppione, ma hai il Salvagente.' : 'Attenzione: sarebbe un Doppione!')
      : 'È sicura: nessun Doppione.';
  } else {
    peekBox.style.display = 'none';
  }

  const prompt = document.getElementById('turn-prompt');
  const canAct = myTurn && me.status === 'ACTIVE' && !state.forcedBusy && !state.isCpuBusy;
  if (canAct) prompt.innerHTML = '<strong>PESCA</strong> una carta o fai <strong>STOP</strong> per tenere i punti.';
  else if (inRound && state.forcedBusy) prompt.textContent = 'Pescate forzate in corso…';
  else if (inRound && current && !myTurn) prompt.textContent = `${current.name} sta decidendo…`;
  else if (inRound && myTurn) prompt.textContent = 'Attendi…';
  else prompt.innerHTML = '&nbsp;';

  document.getElementById('btn-hit').disabled = !canAct;
  document.getElementById('btn-stay').disabled = !canAct;
  const undoBtn = document.getElementById('btn-undo');
  undoBtn.style.display = state.mode === 'online' ? 'none' : '';
  undoBtn.disabled = !canUndo();
  document.getElementById('btn-restart').style.display = isGuest() ? 'none' : '';

  if (isHost()) relay({ k: 'state', s: snapshotForGuest() });
}

function summaryRows(gains) {
  const me = localPlayer();
  const opp = getOpponent(me);
  const row = (p) => {
    const gain = gains ? `<span class="gain">+${gains[p.id] || 0}</span>` : '';
    return `<div class="summary-row"><span class="name">${escapeHtml(p.name)}</span>${gain}<span class="total">tot. <strong>${p.score}</strong></span></div>`;
  };
  return row(me) + row(opp);
}

function showRoundEndModal(gains) {
  document.getElementById('round-end-title').textContent = `Fine mano ${state.roundNumber}`;
  document.getElementById('round-end-summary').innerHTML =
    summaryRows(gains) + `<p class="modal-note">Traguardo: <strong>${state.targetScore}</strong> punti</p>`;
  const btn = document.getElementById('btn-next-round');
  btn.textContent = 'Prossima mano →';
  btn.disabled = false;
  openDialog('round-end-modal');
  if (isHost()) relay({ k: 'roundEnd', gains, roundNumber: state.roundNumber });
}

function showGameEndModal(winner) {
  const me = localPlayer();
  const won = winner.id === me.id;
  if (won) playSfxLocal('win');
  document.getElementById('game-end-title').textContent = won ? '🏆 Hai vinto!' : `😬 Ha vinto ${winner.name}`;
  document.getElementById('game-end-summary').innerHTML = summaryRows(null);
  const btn = document.getElementById('btn-rematch');
  btn.textContent = isGuest() ? 'Chiedi la rivincita' : 'Rivincita';
  btn.disabled = false;
  openDialog('game-end-modal');
}

/* =========================================================
   7. NAVIGAZIONE E CONTROLLI
   ========================================================= */
function openDialog(id) {
  const d = document.getElementById(id);
  if (d && !d.open) d.showModal();
}
function closeDialog(id) {
  const d = document.getElementById(id);
  if (d && d.open) d.close();
}
function closeAllDialogs() {
  document.querySelectorAll('dialog[open]').forEach(d => d.close());
}

function navigateScreen(screenId) {
  document.querySelectorAll('.view-screen').forEach(el => el.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function readNameInput(id) {
  const el = document.getElementById(id);
  const name = (el && el.value.trim()) || settings.playerName || 'Giocatore';
  return name.slice(0, 16);
}

function onNameChange(inputId) {
  settings.playerName = readNameInput(inputId);
  saveSettings();
  document.querySelectorAll('input.name-input').forEach(el => { el.value = settings.playerName; });
}

function renderSetupChoices() {
  document.querySelectorAll('input.name-input').forEach(el => { el.value = settings.playerName; });
  document.querySelectorAll('.level-card').forEach(el => {
    el.classList.toggle('selected', el.dataset.level === settings.level);
  });
  document.querySelectorAll('.seg-btn').forEach(el => {
    el.classList.toggle('selected', parseInt(el.dataset.target, 10) === settings.target);
  });
  const desc = document.getElementById('level-desc');
  if (desc) desc.textContent = LEVEL_INFO[settings.level].desc;
}

function selectLevel(level) {
  if (!LEVEL_INFO[level] || level === 'online') return;
  settings.level = level;
  saveSettings();
  renderSetupChoices();
}

function selectTarget(target) {
  const t = parseInt(target, 10);
  if (!TARGET_OPTIONS.includes(t)) return;
  settings.target = t;
  saveSettings();
  renderSetupChoices();
}

function openSetupScreen() {
  renderSetupChoices();
  navigateScreen('screen-setup');
}

function onHitClick() {
  initAudio();
  if (isGuest()) { relay({ k: 'action', a: 'HIT' }); return; }
  const me = localPlayer();
  if (!me) return;
  const idx = state.players.indexOf(me);
  if (state.phase === 'TURN' && state.currentPlayerIndex === idx && !state.forcedBusy && !state.isCpuBusy) drawCard(idx);
}

function onStayClick() {
  initAudio();
  if (isGuest()) { relay({ k: 'action', a: 'STAY' }); return; }
  const me = localPlayer();
  if (!me) return;
  const idx = state.players.indexOf(me);
  if (state.phase === 'TURN' && state.currentPlayerIndex === idx && !state.forcedBusy && !state.isCpuBusy) playerStay(idx);
}

function canUndo() {
  return state.mode !== 'online' && state.undoStack.length > 0 && !state.isCpuBusy && !state.forcedBusy &&
         state.phase === 'TURN';
}

// L'annulla riporta all'ultimo punto in cui toccava a te decidere: tornare su un turno della
// CPU sarebbe inutile (rigiocherebbe subito la stessa mossa).
function onUndoClick() {
  if (!canUndo()) return;
  bumpSequence();
  let prev = null;
  while (state.undoStack.length > 0) {
    prev = state.undoStack.pop();
    const p = prev.players[prev.currentPlayerIndex];
    if (prev.phase === 'TURN' && p && p.controller === 'local') break;
  }
  if (!prev) return;
  state.players = prev.players;
  state.drawPile = prev.drawPile;
  state.discardPile = prev.discardPile;
  state.usedCards = prev.usedCards;
  state.peek = prev.peek;
  state.currentPlayerIndex = prev.currentPlayerIndex;
  state.dealerIndex = prev.dealerIndex;
  state.roundNumber = prev.roundNumber;
  state.phase = prev.phase;
  state.isCpuBusy = false;
  state.forcedBusy = false;
  setThinking(false);
  afterTurnChange();
}

function onNextRoundClick() {
  if (isGuest()) {
    const btn = document.getElementById('btn-next-round');
    btn.textContent = 'In attesa dell\'altro giocatore…';
    btn.disabled = true;
    relay({ k: 'next' });
    return;
  }
  closeDialog('round-end-modal');
  proceedToNextRound();
}

function onRematchClick() {
  if (isGuest()) {
    const btn = document.getElementById('btn-rematch');
    btn.textContent = 'Richiesta inviata, attendi…';
    btn.disabled = true;
    relay({ k: 'rematch' });
    return;
  }
  closeDialog('game-end-modal');
  if (state.config) startNewGame(state.config);
}

function confirmExitToHome() {
  openDialog('exit-confirm-dialog');
}

function exitToHome() {
  closeAllDialogs();
  bumpSequence();
  if (online.role) leaveOnline(false);
  state = freshState();
  navigateScreen('screen-home');
}

function restartMatch() {
  if (isGuest()) return;
  openDialog('restart-confirm-dialog');
}

function confirmRestartMatch() {
  closeDialog('restart-confirm-dialog');
  if (state.config) startNewGame(state.config);
}

function exitApp() {
  openDialog('exit-app-confirm-dialog');
}

/* =========================================================
   8. MULTIPLAYER ONLINE
   L'host esegue il motore di gioco e invia all'ospite una fotografia dello stato dopo ogni
   aggiornamento; l'ospite invia solo le sue decisioni (PESCA/STOP, prossima mano, rivincita).
   Il server è un semplice relay: crea stanze con codice e inoltra i messaggi tra i due giocatori.
   ========================================================= */
const online = { socket: null, role: null, code: null, peerName: '', myName: '', connecting: false };

function isHost() { return online.role === 'host' && state.mode === 'online' && state.players.length === 2; }
function isGuest() { return online.role === 'guest'; }

function resolveServerUrl() {
  const custom = (settings.serverUrl || '').trim();
  if (custom) return custom.replace(/^http/, 'ws');
  if ((location.protocol === 'http:' || location.protocol === 'https:') && !/github\.io$/.test(location.hostname)) {
    return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
  }
  return '';
}

function setOnlineStatus(text, isError) {
  const el = document.getElementById('online-status');
  el.textContent = text || '';
  el.classList.toggle('error', !!isError);
}

function connectOnline() {
  return new Promise((resolve, reject) => {
    const url = resolveServerUrl();
    if (!url) { reject(new Error('Nessun server online configurato: inseriscilo in Opzioni.')); return; }
    if (online.socket && online.socket.readyState === WebSocket.OPEN) { resolve(online.socket); return; }
    let ws;
    try { ws = new WebSocket(url); } catch (e) { reject(new Error('Indirizzo del server non valido.')); return; }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) { /* ignora */ }
      reject(new Error('Il server non risponde. Controlla l\'indirizzo in Opzioni.'));
    }, 8000);
    ws.onopen = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      online.socket = ws;
      resolve(ws);
    };
    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Connessione al server fallita. Controlla l\'indirizzo in Opzioni.'));
    };
    ws.onmessage = (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg && typeof msg === 'object') handleServerMessage(msg);
    };
    ws.onclose = () => {
      const wasInRoom = !!online.role;
      online.socket = null;
      if (wasInRoom) onPeerGone('Connessione persa con il server.');
    };
  });
}

function onlineSend(obj) {
  if (online.socket && online.socket.readyState === WebSocket.OPEN) online.socket.send(JSON.stringify(obj));
}
function relay(data) {
  if (!online.role) return;
  onlineSend({ t: 'relay', d: data });
}

function openOnlineScreen() {
  renderSetupChoices();
  document.getElementById('online-waiting').style.display = 'none';
  document.getElementById('online-forms').style.display = '';
  document.getElementById('room-code-input').value = '';
  const url = resolveServerUrl();
  setOnlineStatus(url ? `Server: ${url}` : 'Nessun server configurato: aggiungilo in Opzioni.', !url);
  navigateScreen('screen-online');
}

async function onlineCreateRoom() {
  if (online.connecting) return;
  online.connecting = true;
  online.myName = readNameInput('online-name-input');
  settings.playerName = online.myName;
  saveSettings();
  setOnlineStatus('Connessione al server…');
  try {
    await connectOnline();
    onlineSend({ t: 'create', name: online.myName, target: settings.target });
  } catch (e) {
    setOnlineStatus(e.message, true);
  }
  online.connecting = false;
}

async function onlineJoinRoom() {
  if (online.connecting) return;
  const code = document.getElementById('room-code-input').value.trim().toUpperCase();
  if (code.length !== 4) { setOnlineStatus('Inserisci il codice stanza di 4 caratteri.', true); return; }
  online.connecting = true;
  online.myName = readNameInput('online-name-input');
  settings.playerName = online.myName;
  saveSettings();
  setOnlineStatus('Connessione al server…');
  try {
    await connectOnline();
    onlineSend({ t: 'join', code, name: online.myName });
  } catch (e) {
    setOnlineStatus(e.message, true);
  }
  online.connecting = false;
}

function onlineCancel() {
  leaveOnline(false);
  openOnlineScreen();
}

function leaveOnline(silent) {
  const hadRole = !!online.role;
  online.role = null;
  online.code = null;
  online.peerName = '';
  if (online.socket) {
    const ws = online.socket;
    online.socket = null;
    try { ws.onclose = null; ws.send(JSON.stringify({ t: 'leave' })); ws.close(); } catch (e) { /* ignora */ }
  }
  if (hadRole && !silent) showToast('Hai lasciato la stanza.');
}

function onPeerGone(reason) {
  const wasPlaying = document.getElementById('screen-game').classList.contains('active');
  online.role = null;
  online.code = null;
  online.peerName = '';
  if (online.socket) { try { online.socket.onclose = null; online.socket.close(); } catch (e) { /* ignora */ } online.socket = null; }
  bumpSequence();
  closeAllDialogs();
  if (wasPlaying) {
    state = freshState();
    navigateScreen('screen-home');
    showToast(reason || 'L\'altro giocatore ha lasciato la partita.');
  } else {
    openOnlineScreen();
    setOnlineStatus(reason || 'L\'altro giocatore ha lasciato la stanza.', true);
  }
}

function handleServerMessage(msg) {
  switch (msg.t) {
    case 'created':
      online.role = 'host';
      online.code = msg.code;
      document.getElementById('online-forms').style.display = 'none';
      document.getElementById('online-waiting').style.display = '';
      document.getElementById('room-code-display').textContent = msg.code;
      setOnlineStatus('Stanza creata: condividi il codice e attendi l\'avversario.');
      break;
    case 'peer_joined':
      online.peerName = sanitizeName(msg.peerName);
      showToast(`${online.peerName} è entrato: si comincia!`);
      startNewGame({
        mode: 'online',
        targetScore: settings.target,
        players: [
          { id: 'p1', name: online.myName, controller: 'local' },
          { id: 'p2', name: online.peerName, controller: 'remote' }
        ]
      });
      break;
    case 'joined':
      online.role = 'guest';
      online.code = msg.code;
      online.peerName = sanitizeName(msg.peerName);
      bumpSequence();
      state = freshState();
      state.mode = 'online';
      state.localPlayerId = 'p2';
      closeAllDialogs();
      navigateScreen('screen-game');
      showToast(`Sei nella stanza di ${online.peerName}. Attendi la prima mano…`);
      break;
    case 'relay':
      if (msg.d && typeof msg.d === 'object') handleRelay(msg.d);
      break;
    case 'peer_left':
      onPeerGone('L\'altro giocatore ha lasciato la partita.');
      break;
    case 'error':
      setOnlineStatus(typeof msg.message === 'string' ? msg.message : 'Errore dal server.', true);
      break;
    default:
      break;
  }
}

function sanitizeName(name) {
  const clean = String(name || '').replace(/[\x00-\x1f<>]/g, '').trim().slice(0, 16);
  return clean || 'Avversario';
}

// Fotografia dello stato per l'ospite: niente mazzo (solo il conteggio) e la carta sbirciata
// solo se è l'ospite ad averla sbirciata.
function snapshotForGuest() {
  const guestPeek = peekCardFor('p2');
  return {
    players: state.players,
    currentPlayerIndex: state.currentPlayerIndex,
    dealerIndex: state.dealerIndex,
    roundNumber: state.roundNumber,
    phase: state.phase,
    targetScore: state.targetScore,
    winnerId: state.winnerId,
    forcedBusy: state.forcedBusy,
    deckCount: state.drawPile.length,
    peekCard: guestPeek || null
  };
}

function handleRelay(d) {
  if (online.role === 'host') {
    if (!isHost()) return;
    const guestIdx = state.players.findIndex(p => p.controller === 'remote');
    if (d.k === 'action') {
      if (state.phase !== 'TURN' || state.currentPlayerIndex !== guestIdx || state.forcedBusy) return;
      if (d.a === 'HIT') drawCard(guestIdx);
      else if (d.a === 'STAY') playerStay(guestIdx);
    } else if (d.k === 'next') {
      if (state.phase === 'ROUND_END') { closeDialog('round-end-modal'); proceedToNextRound(); }
    } else if (d.k === 'rematch') {
      if (state.phase === 'GAME_END' && state.config) { closeDialog('game-end-modal'); startNewGame(state.config); }
    }
    return;
  }

  if (online.role !== 'guest') return;
  if (d.k === 'state' && d.s && Array.isArray(d.s.players) && d.s.players.length === 2) {
    const s = d.s;
    s.players.forEach(p => { p.name = sanitizeName(p.name); });
    state.players = s.players;
    state.currentPlayerIndex = s.currentPlayerIndex;
    state.dealerIndex = s.dealerIndex;
    state.roundNumber = s.roundNumber;
    state.phase = s.phase;
    state.targetScore = s.targetScore;
    state.winnerId = s.winnerId;
    state.forcedBusy = !!s.forcedBusy;
    state.remote.deckCount = s.deckCount || 0;
    state.remote.peekCard = s.peekCard || null;
    if (state.phase === 'TURN') { closeDialog('round-end-modal'); closeDialog('game-end-modal'); }
    renderGame();
  } else if (d.k === 'msg') {
    showGameMessageLocal(String(d.text || '').slice(0, 200));
  } else if (d.k === 'sfx') {
    playSfxLocal(String(d.name || ''));
  } else if (d.k === 'roundEnd') {
    if (state.players.length === 2) showRoundEndModal(d.gains || {});
  } else if (d.k === 'gameEnd') {
    const winner = state.players.find(p => p.id === d.winnerId);
    if (!winner) return;
    state.phase = 'GAME_END';
    state.winnerId = winner.id;
    closeDialog('round-end-modal');
    renderGame();
    saveGameStats(winner.id === state.localPlayerId ? 'win' : 'loss');
    showGameEndModal(winner);
  }
}

/* =========================================================
   9. STATISTICHE
   ========================================================= */
const STATS_CATEGORIES = [
  { key: 'easy', label: 'CPU Facile (Prudente)' },
  { key: 'normal', label: 'CPU Medio (Calcolatore)' },
  { key: 'hard', label: 'CPU Difficile (Stratega)' },
  { key: 'online', label: 'Online' }
];

function defaultStats() {
  const categories = {};
  STATS_CATEGORIES.forEach(c => { categories[c.key] = { wins: 0, losses: 0, total: 0 }; });
  return { total: 0, categories };
}

function loadStats() {
  const raw = localStorage.getItem(LS('stats'));
  if (!raw) return defaultStats();
  try {
    const parsed = JSON.parse(raw);
    const base = defaultStats();
    return { total: parsed.total || 0, categories: Object.assign(base.categories, parsed.categories || {}) };
  } catch (e) {
    return defaultStats();
  }
}

function saveGameStats(result) {
  const stats = loadStats();
  const cat = state.mode;
  if (!stats.categories[cat]) stats.categories[cat] = { wins: 0, losses: 0, total: 0 };
  stats.total++;
  stats.categories[cat].total++;
  if (result === 'win') stats.categories[cat].wins++; else stats.categories[cat].losses++;
  try { localStorage.setItem(LS('stats'), JSON.stringify(stats)); } catch (e) { /* ignora */ }
}

function openStatsModal() {
  const stats = loadStats();
  const rows = STATS_CATEGORIES.map(c => {
    const s = stats.categories[c.key];
    const winRate = s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0;
    return `<div class="stat-block">
      <div class="stat-title">${c.label}</div>
      <div class="stat-row"><span>Partite: ${s.total}</span><span class="ok">Vinte: ${s.wins}</span><span class="ko">Perse: ${s.losses}</span><span>${winRate}%</span></div>
    </div>`;
  }).join('');
  document.getElementById('stats-summary').innerHTML = `<div class="stat-block"><strong>Partite totali:</strong> ${stats.total}</div>${rows}`;
  openDialog('stats-modal');
}

function resetStats() { openDialog('reset-stats-confirm-dialog'); }

function confirmResetStats() {
  closeDialog('reset-stats-confirm-dialog');
  localStorage.removeItem(LS('stats'));
  openStatsModal();
  showToast('Statistiche azzerate.');
}

/* =========================================================
   10. OPZIONI, TOAST E MESSAGGI DI GIOCO
   ========================================================= */
function openSettingsModal() {
  document.getElementById('sound-select').value = settings.soundEnabled ? 'on' : 'off';
  document.getElementById('server-url-input').value = settings.serverUrl || '';
  document.getElementById('server-url-hint').textContent = resolveServerUrl()
    ? `In uso: ${resolveServerUrl()}`
    : 'Nessun server rilevato: inserisci l\'indirizzo (es. wss://tuo-server.onrender.com).';
  openDialog('settings-modal');
}

function saveSoundSetting(val) {
  settings.soundEnabled = val === 'on';
  saveSettings();
}

function saveServerUrl(val) {
  settings.serverUrl = (val || '').trim();
  saveSettings();
  document.getElementById('server-url-hint').textContent = resolveServerUrl() ? `In uso: ${resolveServerUrl()}` : 'Nessun server configurato.';
  showToast('Server salvato.');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Striscia messaggi dentro la schermata di gioco (Doppione, Filotto, poteri…): ha sempre il suo
// spazio riservato tra la barra di stato e il tavolo, quindi non copre mai carte o pulsanti.
function showGameMessageLocal(msg) {
  const bar = document.getElementById('game-message-bar');
  if (!bar) return;
  bar.textContent = msg;
  bar.classList.add('show');
  clearTimeout(showGameMessageLocal._timer);
  showGameMessageLocal._timer = setTimeout(() => {
    bar.classList.remove('show');
    setTimeout(() => { if (!bar.classList.contains('show')) bar.textContent = ' '; }, 260);
  }, 3200);
}

function showGameMessage(msg) {
  showGameMessageLocal(msg);
  if (isHost()) relay({ k: 'msg', text: msg });
}

/* =========================================================
   11. PWA (installazione iOS/Android, service worker, pull-to-refresh)
   ========================================================= */
const isIOSDevice = () =>
  (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && !window.MSStream;

const isRunningStandalone = () =>
  ('standalone' in window.navigator && window.navigator.standalone === true) ||
  window.matchMedia('(display-mode: standalone)').matches ||
  window.matchMedia('(display-mode: fullscreen)').matches;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredAndroidPrompt = e;
  if (!isRunningStandalone()) document.getElementById('android-install-banner').style.display = 'flex';
});

function triggerAndroidInstall() {
  if (!deferredAndroidPrompt) return;
  deferredAndroidPrompt.prompt();
  deferredAndroidPrompt.userChoice.then((choice) => {
    if (choice.outcome === 'accepted') document.getElementById('android-install-banner').style.display = 'none';
    deferredAndroidPrompt = null;
  });
}

function dismissIosBanner() {
  document.getElementById('ios-install-banner').style.display = 'none';
  sessionStorage.setItem(LS('ios_dismissed'), 'true');
}

window.addEventListener('DOMContentLoaded', () => {
  loadSettings();
  renderSetupChoices();
  const iosBannerDismissed = sessionStorage.getItem(LS('ios_dismissed'));
  if (isIOSDevice() && !isRunningStandalone() && !iosBannerDismissed) {
    document.getElementById('ios-install-banner').style.display = 'flex';
  }
  const codeInput = document.getElementById('room-code-input');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); });
  codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') onlineJoinRoom(); });
});

window.addEventListener('beforeunload', () => { if (online.role) leaveOnline(true); });

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('Service worker non registrato:', err));
  });
}

async function performCacheRefresh() {
  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map(k => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map(r => r.unregister()));
    }
  } catch (e) {
    console.warn('Pulizia cache fallita:', e);
  }
  location.reload();
}

(function setupPullToRefresh() {
  const indicator = document.getElementById('pull-refresh-indicator');
  const icon = document.getElementById('pull-refresh-icon');
  const THRESHOLD = 70;
  const MAX_PULL = 100;
  let startY = 0, armed = false, pulling = false, refreshing = false;

  document.addEventListener('touchstart', (e) => {
    if (refreshing || document.querySelector('dialog[open]') || e.touches.length !== 1) return;
    if (!document.getElementById('screen-home').classList.contains('active')) return; // solo dalla home
    startY = e.touches[0].clientY;
    armed = true;
    pulling = false;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!armed || refreshing) return;
    const deltaY = e.touches[0].clientY - startY;
    if (deltaY <= 0) { pulling = false; return; }
    pulling = true;
    const pull = Math.min(deltaY * 0.45, MAX_PULL);
    indicator.classList.add('pulling');
    indicator.style.transform = `translate(-50%, ${pull - 60}px)`;
    indicator.style.opacity = Math.min(pull / THRESHOLD, 1);
    indicator.classList.toggle('ready', pull >= THRESHOLD * 0.85);
    icon.style.transform = `rotate(${pull * 2.4}deg)`;
  }, { passive: true });

  document.addEventListener('touchend', () => {
    if (!armed) return;
    armed = false;
    indicator.classList.remove('pulling');
    if (pulling && indicator.classList.contains('ready')) {
      refreshing = true;
      indicator.classList.add('refreshing');
      indicator.style.transform = 'translate(-50%, 14px)';
      indicator.style.opacity = '1';
      performCacheRefresh();
    } else {
      indicator.style.transform = 'translate(-50%, -60px)';
      indicator.style.opacity = '0';
      indicator.classList.remove('ready');
    }
    pulling = false;
  }, { passive: true });
})();
