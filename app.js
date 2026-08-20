/**
 * Flip 7 - Vanilla JS game engine, probability-aware AI, Gemini integration, PWA logic.
 */

/* =========================================================
   1. STATE
   ========================================================= */
let state = {
  drawPile: [],
  discardPile: [],
  usedCards: [],
  players: [],
  currentPlayerIndex: 0,
  dealerIndex: 0,
  roundNumber: 1,
  phase: 'SETUP', // SETUP | PLAYER_TURN | AI_TURN | CHOOSING_TARGET | ROUND_END | GAME_END
  pendingEffects: [],
  currentPendingEffect: null,
  winnerId: null,
  mode: 'normal', // easy | normal | hard | gemini
  p1Name: 'Giocatore',
  discoveredFlashModels: [],
  settings: { soundEnabled: true }
};

let deferredAndroidPrompt = null;

/* =========================================================
   2. DECK, SCORING & DECK UTILITIES
   ========================================================= */
function createDeck() {
  const deck = [];
  let idCounter = 1;

  for (let val = 0; val <= 12; val++) {
    const copies = val === 0 ? 1 : val;
    for (let c = 0; c < copies; c++) {
      deck.push({ id: `n${val}-${c}-${idCounter++}`, type: 'NUMBER', value: val });
    }
  }

  [2, 4, 6, 8, 10].forEach(v => {
    deck.push({ id: `plus${v}-${idCounter++}`, type: 'MODIFIER', effect: 'PLUS', value: v });
  });
  deck.push({ id: `mult2-${idCounter++}`, type: 'MODIFIER', effect: 'MULTIPLIER_TWO' });

  for (let i = 0; i < 3; i++) {
    deck.push({ id: `freeze${i}-${idCounter++}`, type: 'ACTION', effect: 'FREEZE' });
    deck.push({ id: `flip3-${i}-${idCounter++}`, type: 'ACTION', effect: 'FLIP_THREE' });
    deck.push({ id: `sc${i}-${idCounter++}`, type: 'ACTION', effect: 'SECOND_CHANCE' });
  }

  return deck; // 79 number + 6 modifier + 9 action = 94 cards
}

function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function calculateRoundScore(player) {
  if (player.status === 'BUSTED') return { score: 0, isFlip7: false };

  const uniqueNumbers = new Set();
  let numberSum = 0;
  for (const c of player.numberCards) {
    uniqueNumbers.add(c.value);
    numberSum += c.value;
  }

  const isFlip7 = uniqueNumbers.size >= 7;
  const hasMultiplierTwo = player.modifierCards.some(c => c.effect === 'MULTIPLIER_TWO');
  const plusTotal = player.modifierCards.filter(c => c.effect === 'PLUS').reduce((s, c) => s + c.value, 0);

  let baseScore = numberSum;
  if (hasMultiplierTwo) baseScore *= 2;

  let total = baseScore + plusTotal;
  if (isFlip7) total += 15;

  return { score: total, isFlip7 };
}

function countUniqueNumbers(player) {
  const set = new Set();
  for (const c of player.numberCards) set.add(c.value);
  return set.size;
}

function rebuildDeckIfNeeded() {
  if (state.drawPile.length > 0) return;

  const activeTableCards = new Set();
  for (const p of state.players) {
    for (const c of p.numberCards) activeTableCards.add(c.id);
    for (const c of p.modifierCards) activeTableCards.add(c.id);
    if (p.secondChanceCard) activeTableCards.add(p.secondChanceCard.id);
  }

  const cardsToShuffle = [...state.discardPile, ...state.usedCards].filter(c => !activeTableCards.has(c.id));
  state.drawPile = shuffle(cardsToShuffle);
  state.discardPile = [];
  state.usedCards = state.usedCards.filter(c => activeTableCards.has(c.id));
}

/* =========================================================
   3. AUDIO (bust sound only, respects the sound setting)
   ========================================================= */
let audioCtx = null;
function initAudio() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) audioCtx = new AudioContextClass();
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function playBustSound() {
  if (!state.settings.soundEnabled) return;
  initAudio();
  if (!audioCtx) return;
  try {
    const now = audioCtx.currentTime;
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.type = 'sawtooth';
    osc1.frequency.setValueAtTime(220, now);
    osc1.frequency.exponentialRampToValueAtTime(50, now + 0.5);
    gain1.gain.setValueAtTime(0.3, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
    osc1.connect(gain1);
    gain1.connect(audioCtx.destination);
    osc1.start(now);
    osc1.stop(now + 0.5);
  } catch (e) { /* audio best-effort */ }
}

/* =========================================================
   4. GAME FLOW
   ========================================================= */
function startNewGame() {
  initAudio();
  state.p1Name = document.getElementById('p1-name-input').value.trim() || 'Giocatore';
  state.mode = document.getElementById('difficulty-select').value;
  saveProfile();

  state.drawPile = shuffle(createDeck());
  state.discardPile = [];
  state.usedCards = [];
  state.players = [
    { id: 'player-human', name: state.p1Name, isHuman: true, score: 0, roundScore: 0, status: 'ACTIVE', numberCards: [], modifierCards: [], secondChanceCard: undefined },
    { id: 'player-ai', name: 'IA', isHuman: false, score: 0, roundScore: 0, status: 'ACTIVE', numberCards: [], modifierCards: [], secondChanceCard: undefined }
  ];
  state.currentPlayerIndex = 0;
  state.dealerIndex = 0;
  state.roundNumber = 1;
  state.phase = 'SETUP';
  state.pendingEffects = [];
  state.currentPendingEffect = null;
  state.winnerId = null;

  navigateScreen('screen-game');
  startRound();
}

function startRound() {
  state.players.forEach(p => {
    p.roundScore = 0;
    p.status = 'ACTIVE';
    p.numberCards = [];
    p.modifierCards = [];
    p.secondChanceCard = undefined;
  });

  state.discardPile = [...state.discardPile, ...state.usedCards];
  state.usedCards = [];
  state.pendingEffects = [];
  state.currentPendingEffect = null;

  rebuildDeckIfNeeded();

  const startIndex = (state.dealerIndex + 1) % state.players.length;
  for (let i = 0; i < state.players.length; i++) {
    dealInitialCard((startIndex + i) % state.players.length);
  }

  state.currentPlayerIndex = (state.dealerIndex + 1) % state.players.length;
  const firstPlayer = state.players[state.currentPlayerIndex];
  state.phase = firstPlayer.isHuman ? 'PLAYER_TURN' : 'AI_TURN';

  renderGame();
  triggerAITurnIfNeeded();
}

function dealInitialCard(playerIndex) {
  rebuildDeckIfNeeded();
  if (state.drawPile.length === 0) return;
  const card = state.drawPile.shift();
  state.usedCards.push(card);
  applyCardToPlayer(playerIndex, card, true);
}

function drawCard(playerIndex) {
  rebuildDeckIfNeeded();
  if (state.drawPile.length === 0) return;
  const player = state.players[playerIndex];
  if (player.status !== 'ACTIVE') return;
  const card = state.drawPile.shift();
  state.usedCards.push(card);
  applyCardToPlayer(playerIndex, card, false);
}

// inForcedSequence=true (used during initial deal & FLIP_THREE forced draws) skips the
// automatic turn-advance for "safe" outcomes, since the caller is driving the sequence itself.
function applyCardToPlayer(playerIndex, card, inForcedSequence) {
  const player = state.players[playerIndex];
  const whoName = player.isHuman ? state.p1Name : 'IA';

  if (card.type === 'NUMBER') {
    const hasDuplicate = player.numberCards.some(c => c.value === card.value);

    if (hasDuplicate) {
      if (player.secondChanceCard) {
        showToast(`🛡️ ${whoName} si salva dal BUST con Second Chance!`);
        state.discardPile.push(card, player.secondChanceCard);
        player.secondChanceCard = undefined;
        if (!inForcedSequence) checkTurnOrRoundEnd(); else renderGame();
        return;
      }
      playBustSound();
      showToast(`💥 ${whoName} è andato in BUST!`);
      player.status = 'BUSTED';
      player.roundScore = 0;
      checkTurnOrRoundEnd();
      return;
    }

    player.numberCards.push(card);
    const res = calculateRoundScore(player);
    if (res.isFlip7) {
      showToast(`🎉 FLIP 7! ${whoName} +15 punti bonus!`);
      player.status = 'FLIP_7';
      player.roundScore = res.score;
      endRoundImmediatelyOnFlip7(playerIndex);
      return;
    }
    player.roundScore = res.score;
    if (!inForcedSequence) checkTurnOrRoundEnd(); else renderGame();
    return;
  }

  if (card.type === 'MODIFIER') {
    player.modifierCards.push(card);
    player.roundScore = calculateRoundScore(player).score;
    if (!inForcedSequence) checkTurnOrRoundEnd(); else renderGame();
    return;
  }

  if (card.type === 'ACTION') {
    if (card.effect === 'SECOND_CHANCE') {
      if (!player.secondChanceCard) {
        player.secondChanceCard = card;
      } else {
        const recipient = state.players.find((p, idx) => idx !== playerIndex && !p.secondChanceCard && p.status === 'ACTIVE');
        if (recipient) {
          recipient.secondChanceCard = card;
          showToast(`🛡️ Second Chance passata a ${recipient.isHuman ? state.p1Name : 'IA'}`);
        } else {
          state.discardPile.push(card);
        }
      }
      if (!inForcedSequence) checkTurnOrRoundEnd(); else renderGame();
      return;
    }

    if (card.effect === 'FREEZE' || card.effect === 'FLIP_THREE') {
      const activeTargets = state.players.filter(p => p.status === 'ACTIVE');
      const effect = { id: `effect-${Date.now()}-${Math.random()}`, type: card.effect, sourcePlayerId: player.id };

      if (activeTargets.length <= 1) {
        resolveEffectOnTarget(effect, (activeTargets[0] || player).id);
        return;
      }

      state.pendingEffects.push(effect);
      state.phase = 'CHOOSING_TARGET';
      state.currentPendingEffect = effect;
      renderGame();

      if (!player.isHuman) triggerAITargetSelectionIfNeeded();
      else showHumanTargetModal(effect);
      return;
    }
  }
}

function resolveEffectOnTarget(effect, targetPlayerId) {
  const targetPlayer = state.players.find(p => p.id === targetPlayerId);
  if (!targetPlayer) { checkTurnOrRoundEnd(); return; }
  const whoName = targetPlayer.isHuman ? state.p1Name : 'IA';

  if (effect.type === 'FREEZE') {
    showToast(`❄️ FREEZE su ${whoName}: costretto a fermarsi.`);
    targetPlayer.status = 'FREEZED';
    targetPlayer.roundScore = calculateRoundScore(targetPlayer).score;
    checkTurnOrRoundEnd();
    return;
  }

  if (effect.type === 'FLIP_THREE') {
    showToast(`🎲 FLIP THREE su ${whoName}: pesca 3 carte di fila!`);
    processFlipThreeDraw(state.players.findIndex(p => p.id === targetPlayerId), 3);
    return;
  }
}

function resolveTargetSelection(targetPlayerId) {
  if (!state.currentPendingEffect) return;
  const effect = state.currentPendingEffect;
  state.pendingEffects = state.pendingEffects.filter(e => e.id !== effect.id);
  state.currentPendingEffect = null;
  resolveEffectOnTarget(effect, targetPlayerId);
}

function processFlipThreeDraw(targetIdx, remainingDraws) {
  const targetPlayer = state.players[targetIdx];
  if (remainingDraws <= 0 || targetPlayer.status !== 'ACTIVE') { checkTurnOrRoundEnd(); return; }

  rebuildDeckIfNeeded();
  if (state.drawPile.length === 0) { checkTurnOrRoundEnd(); return; }

  const card = state.drawPile.shift();
  state.usedCards.push(card);
  applyCardToPlayer(targetIdx, card, true);

  if (targetPlayer.status === 'BUSTED' || targetPlayer.status === 'FLIP_7') return;

  if (remainingDraws - 1 > 0) {
    setTimeout(() => processFlipThreeDraw(targetIdx, remainingDraws - 1), 550);
  } else {
    checkTurnOrRoundEnd();
  }
}

function playerStay(playerIndex) {
  const player = state.players[playerIndex];
  if (player.status !== 'ACTIVE') return;
  player.status = 'STAYED';
  player.roundScore = calculateRoundScore(player).score;
  checkTurnOrRoundEnd();
}

function checkTurnOrRoundEnd() {
  if (state.pendingEffects.length > 0 && !state.currentPendingEffect) {
    const effect = state.pendingEffects[0];
    state.currentPendingEffect = effect;
    state.phase = 'CHOOSING_TARGET';
    renderGame();
    const source = state.players.find(p => p.id === effect.sourcePlayerId);
    if (source && !source.isHuman) triggerAITargetSelectionIfNeeded();
    else if (source) showHumanTargetModal(effect);
    return;
  }

  const activePlayers = state.players.filter(p => p.status === 'ACTIVE');
  if (activePlayers.length === 0) { endRound(); return; }

  let nextIdx = (state.currentPlayerIndex + 1) % state.players.length;
  let guard = 0;
  while (state.players[nextIdx].status !== 'ACTIVE' && guard < state.players.length) {
    nextIdx = (nextIdx + 1) % state.players.length;
    guard++;
  }
  state.currentPlayerIndex = nextIdx;
  const nextPlayer = state.players[nextIdx];
  state.phase = nextPlayer.isHuman ? 'PLAYER_TURN' : 'AI_TURN';

  renderGame();
  triggerAITurnIfNeeded();
}

function endRoundImmediatelyOnFlip7(winnerIdx) {
  const gains = {};
  state.players.forEach((p, idx) => {
    if (idx === winnerIdx) { p.score += p.roundScore; gains[p.id] = p.roundScore; }
    else if (p.status === 'BUSTED') { p.roundScore = 0; gains[p.id] = 0; }
    else {
      const res = calculateRoundScore(p);
      p.roundScore = res.score;
      p.score += res.score;
      gains[p.id] = res.score;
    }
  });

  state.phase = 'ROUND_END';
  renderGame();
  if (!checkGameOver()) showRoundEndModal(gains);
}

function endRound() {
  const gains = {};
  state.players.forEach(p => {
    if (p.status === 'BUSTED') { p.roundScore = 0; gains[p.id] = 0; }
    else {
      const res = calculateRoundScore(p);
      p.roundScore = res.score;
      p.score += res.score;
      gains[p.id] = res.score;
    }
  });

  state.phase = 'ROUND_END';
  renderGame();
  if (!checkGameOver()) showRoundEndModal(gains);
}

function checkGameOver() {
  const targetScore = 200;
  const reached = state.players.filter(p => p.score >= targetScore);
  if (reached.length === 0) return false;

  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  if (sorted[0].score > sorted[1].score) {
    const winner = sorted[0];
    state.phase = 'GAME_END';
    state.winnerId = winner.id;
    saveGameStats(winner.isHuman ? 'human' : 'ai');
    showGameEndModal(winner);
    return true;
  }
  return false; // tie above 200: keep playing
}

function proceedToNextRound() {
  if (state.phase !== 'ROUND_END') return;
  state.dealerIndex = (state.dealerIndex + 1) % state.players.length;
  state.roundNumber += 1;
  startRound();
}

/* =========================================================
   5. AI STRATEGY (probability-aware) + GEMINI INTEGRATION
   ========================================================= */
function computeHitStats(player) {
  const remaining = state.drawPile;
  const total = remaining.length;
  if (total === 0) return { bustProb: 0, avgGainIfSafe: 3, total: 0 };

  const heldValues = new Set(player.numberCards.map(c => c.value));
  let dangerCount = 0, safeValueSum = 0, safeCount = 0;

  for (const c of remaining) {
    if (c.type === 'NUMBER') {
      if (heldValues.has(c.value)) dangerCount++;
      else { safeValueSum += c.value; safeCount++; }
    } else if (c.type === 'MODIFIER') {
      safeCount++;
      safeValueSum += (c.effect === 'MULTIPLIER_TWO') ? 7 : c.value;
    } else {
      safeCount++;
      safeValueSum += 1.5; // action cards: mild, roughly-neutral estimated value
    }
  }

  return {
    bustProb: dangerCount / total,
    avgGainIfSafe: safeCount > 0 ? safeValueSum / safeCount : 0,
    total
  };
}

function chooseAIActionHeuristic(aiIndex, level) {
  const ai = state.players[aiIndex];
  const human = state.players.find(p => p.isHuman) || state.players[0];
  const uniqueCount = countUniqueNumbers(ai);
  const roundScore = ai.roundScore;

  if (ai.score + roundScore >= 200) return 'STAY'; // lock in the win

  const { bustProb, avgGainIfSafe } = computeHitStats(ai);

  if (level === 'easy') {
    if (roundScore === 0) return 'HIT';
    if (bustProb > 0.6 && Math.random() < 0.7) return 'STAY';
    return Math.random() < 0.45 ? 'STAY' : 'HIT';
  }

  if (level === 'normal') {
    if (ai.secondChanceCard && bustProb < 0.55) return 'HIT';
    if (uniqueCount >= 6) return 'HIT';
    const evGain = (1 - bustProb) * avgGainIfSafe;
    const evLoss = bustProb * roundScore;
    return evGain > evLoss ? 'HIT' : 'STAY';
  }

  // hard
  if (ai.secondChanceCard && bustProb < 0.65) return 'HIT';
  if (uniqueCount >= 6) return 'HIT';
  let evGain = (1 - bustProb) * avgGainIfSafe;
  const evLoss = bustProb * roundScore;
  if (ai.score < human.score) evGain *= 1.15; // slightly more risk-tolerant when behind
  return evGain > evLoss ? 'HIT' : 'STAY';
}

function chooseAITarget(aiIndex, effectType) {
  const ai = state.players[aiIndex];
  const human = state.players.find(p => p.isHuman);
  if (!human || human.status !== 'ACTIVE') return ai.id;

  if (effectType === 'FREEZE') {
    return (human.roundScore > 8 || human.roundScore >= ai.roundScore * 0.5) ? human.id : ai.id;
  }
  if (effectType === 'FLIP_THREE') {
    const aiStats = computeHitStats(ai);
    if (countUniqueNumbers(ai) >= 5 && aiStats.bustProb < 0.3) return ai.id;
    return human.id;
  }
  return human.id;
}

async function callGeminiRaw(prompt) {
  const apiKey = localStorage.getItem('flip7_gemini_key') || '';
  if (!apiKey) return null;

  if (!state.discoveredFlashModels || state.discoveredFlashModels.length === 0) {
    state.discoveredFlashModels = await discoverLatestFlashModels(apiKey);
  }
  const modelsToTry = (state.discoveredFlashModels && state.discoveredFlashModels.length > 0)
    ? state.discoveredFlashModels
    : ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash'];

  for (const model of modelsToTry) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 300 }
        })
      });
      if (res.ok) {
        const data = await res.json();
        return data.candidates[0].content.parts[0].text;
      }
    } catch (e) {
      console.warn(`Gemini model ${model} failed, trying next...`, e);
    }
  }
  return null;
}

function buildGeminiHitStayPrompt(aiIndex) {
  const ai = state.players[aiIndex];
  const human = state.players.find(p => p.isHuman);
  const stats = computeHitStats(ai);
  const heldNumbers = ai.numberCards.map(c => c.value).sort((a, b) => a - b).join(', ') || 'nessuno';
  const modifiers = ai.modifierCards.map(c => c.effect === 'MULTIPLIER_TWO' ? 'x2' : `+${c.value}`).join(', ') || 'nessuno';

  return `Sei un giocatore ESPERTO di Flip 7, un gioco di carte "push your luck". Stai decidendo la mossa dell'IA.

REGOLE ESSENZIALI:
- Mazzo: carte Numero 0-12 (copie = valore, lo 0 ne ha 1 sola), Modificatori (+2,+4,+6,+8,+10,x2), Azioni (FREEZE, FLIP THREE, SECOND CHANCE).
- Se peschi un numero che hai già, vai in BUST e perdi tutti i punti della mano (a meno di avere Second Chance).
- 7 numeri diversi = FLIP 7: mano finita subito, bonus +15.
- Punteggio mano = (somma numeri, ×2 se hai il modificatore x2) + somma dei +N. Vince chi arriva primo a 200 punti totali.

STATO ATTUALE:
- Tuoi numeri: ${heldNumbers} (${countUniqueNumbers(ai)}/7 unici)
- Tuoi modificatori: ${modifiers}
- Second Chance in mano: ${ai.secondChanceCard ? 'sì' : 'no'}
- Punteggio mano se ti fermi ora: ${ai.roundScore}
- Punteggio totale tuo: ${ai.score} — avversario: ${human.score}
- Carte rimaste nel mazzo: ${stats.total}
- PROBABILITÀ ESATTA DI BUST se peschi ora: ${(stats.bustProb * 100).toFixed(1)}%
- Valore medio atteso se peschi in sicurezza: ~${stats.avgGainIfSafe.toFixed(1)} punti

Usa la probabilità di bust data sopra (è esatta, calcolata sul mazzo reale): non stimarla tu. Decidi HIT (pesca) o STAY (fermati) pensando al rischio contro il guadagno atteso. Pensa brevemente, poi rispondi SOLO con un JSON come ultima riga, es: {"action": "HIT"}`;
}

async function chooseGeminiAction(aiIndex) {
  const text = await callGeminiRaw(buildGeminiHitStayPrompt(aiIndex));
  if (text) {
    const matches = text.match(/\{[^{}]*\}/g);
    if (matches) {
      try {
        const obj = JSON.parse(matches[matches.length - 1]);
        if (obj.action === 'HIT' || obj.action === 'STAY') return obj.action;
      } catch (e) { /* fall through to heuristic */ }
    }
  }
  return chooseAIActionHeuristic(aiIndex, 'hard');
}

async function chooseGeminiTarget(aiIndex, effectType) {
  const ai = state.players[aiIndex];
  const human = state.players.find(p => p.isHuman);
  const prompt = `Sei un'IA esperta di Flip 7. Hai pescato una carta ${effectType === 'FREEZE' ? 'FREEZE (il bersaglio è costretto a fermarsi subito con il punteggio attuale)' : 'FLIP THREE (il bersaglio deve pescare 3 carte di fila, rischiando il BUST)'}.
Devi scegliere il bersaglio: te stesso oppure l'avversario.

STATO:
- Tuo punteggio mano potenziale: ${ai.roundScore}, totale: ${ai.score}
- Punteggio mano potenziale avversario: ${human.roundScore}, totale: ${human.score}
- Avversario ha Second Chance: ${human.secondChanceCard ? 'sì' : 'no'}

Scegli la mossa più conveniente per te. Rispondi SOLO con un JSON come ultima riga, es: {"target": "opponent"} oppure {"target": "self"}`;

  const text = await callGeminiRaw(prompt);
  if (text) {
    const matches = text.match(/\{[^{}]*\}/g);
    if (matches) {
      try {
        const obj = JSON.parse(matches[matches.length - 1]);
        if (obj.target === 'self') return ai.id;
        if (obj.target === 'opponent') return human.id;
      } catch (e) { /* fall through to heuristic */ }
    }
  }
  return chooseAITarget(aiIndex, effectType);
}

function triggerAITurnIfNeeded() {
  if (state.phase !== 'AI_TURN') return;
  const aiIdx = state.players.findIndex(p => !p.isHuman && p.status === 'ACTIVE');
  if (aiIdx === -1) return;

  setAiThinking(true);

  if (state.mode === 'gemini') {
    chooseGeminiAction(aiIdx).then(action => {
      setTimeout(() => {
        setAiThinking(false);
        if (action === 'HIT') drawCard(aiIdx); else playerStay(aiIdx);
      }, 350);
    });
  } else {
    const delay = Math.floor(Math.random() * 650) + 650;
    setTimeout(() => {
      setAiThinking(false);
      const action = chooseAIActionHeuristic(aiIdx, state.mode);
      if (action === 'HIT') drawCard(aiIdx); else playerStay(aiIdx);
    }, delay);
  }
}

function triggerAITargetSelectionIfNeeded() {
  if (state.phase !== 'CHOOSING_TARGET' || !state.currentPendingEffect) return;
  const effect = state.currentPendingEffect;
  const sourcePlayer = state.players.find(p => p.id === effect.sourcePlayerId);
  if (!sourcePlayer || sourcePlayer.isHuman) return;

  const aiIdx = state.players.findIndex(p => p.id === sourcePlayer.id);
  setAiThinking(true);

  if (state.mode === 'gemini') {
    chooseGeminiTarget(aiIdx, effect.type).then(targetId => {
      setTimeout(() => { setAiThinking(false); resolveTargetSelection(targetId); }, 400);
    });
  } else {
    setTimeout(() => {
      setAiThinking(false);
      resolveTargetSelection(chooseAITarget(aiIdx, effect.type));
    }, 850);
  }
}

/* =========================================================
   6. RENDERING
   ========================================================= */
function createCardChip(card) {
  const div = document.createElement('div');
  if (card.type === 'NUMBER') {
    div.className = 'card-chip chip-number';
    div.textContent = card.value;
  } else if (card.type === 'MODIFIER') {
    div.className = 'card-chip chip-modifier';
    div.textContent = card.effect === 'MULTIPLIER_TWO' ? 'x2' : `+${card.value}`;
  } else {
    div.className = 'card-chip chip-action';
    div.textContent = card.effect === 'FREEZE' ? '❄️' : (card.effect === 'FLIP_THREE' ? '🎲' : '🛡️');
  }
  return div;
}

function renderStatusBadge(element, status, roundScore) {
  element.className = 'badge-status ';
  if (status === 'ACTIVE') { element.classList.add('status-active'); element.textContent = 'ATTIVO'; }
  else if (status === 'STAYED') { element.classList.add('status-stayed'); element.textContent = `FERMO (${roundScore}pt)`; }
  else if (status === 'BUSTED') { element.classList.add('status-busted'); element.textContent = 'BUST (0pt)'; }
  else if (status === 'FREEZED') { element.classList.add('status-freezed'); element.textContent = 'FREEZE'; }
  else if (status === 'FLIP_7') { element.classList.add('status-flip7'); element.textContent = '🎉 FLIP 7'; }
}

function renderPlayerZone(player, prefix, isActiveTurn, inRound) {
  document.getElementById(`${prefix}-total`).textContent = player.score;
  document.getElementById(`${prefix}-round-score`).textContent = player.roundScore;
  document.getElementById(`${prefix}-unique`).textContent = countUniqueNumbers(player);
  renderStatusBadge(document.getElementById(`${prefix}-status-badge`), player.status, player.roundScore);

  const cardsBox = document.getElementById(`${prefix}-cards`);
  cardsBox.innerHTML = '';
  player.numberCards.forEach(c => cardsBox.appendChild(createCardChip(c)));
  player.modifierCards.forEach(c => cardsBox.appendChild(createCardChip(c)));
  if (player.secondChanceCard) cardsBox.appendChild(createCardChip(player.secondChanceCard));

  const zone = document.getElementById(`${prefix}-zone`);
  zone.classList.toggle('active-turn', inRound && isActiveTurn);
  zone.classList.toggle('inactive-turn', inRound && !isActiveTurn);
}

function setAiThinking(active) {
  document.getElementById('status-thinking-dots').style.display = active ? 'flex' : 'none';
}

function renderGame() {
  const human = state.players.find(p => p.isHuman);
  const ai = state.players.find(p => !p.isHuman);
  if (!human || !ai) return;

  document.getElementById('human-name').textContent = state.p1Name;
  document.getElementById('status-right').innerHTML =
    `Tu <strong>${human.score}</strong> · IA <strong>${ai.score}</strong> · 🂠<strong>${state.drawPile.length}</strong>`;

  const inRound = state.phase === 'PLAYER_TURN' || state.phase === 'AI_TURN' || state.phase === 'CHOOSING_TARGET';
  const currentPlayer = state.players[state.currentPlayerIndex];

  renderPlayerZone(human, 'human', inRound && currentPlayer && currentPlayer.isHuman, inRound);
  renderPlayerZone(ai, 'ai', inRound && currentPlayer && !currentPlayer.isHuman, inRound);

  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (currentPlayer && inRound) {
    dot.style.background = currentPlayer.isHuman ? 'var(--gold)' : 'var(--purple)';
    text.textContent = currentPlayer.isHuman ? `Turno: ${state.p1Name}` : 'Turno: IA';
  } else if (state.phase === 'ROUND_END') {
    dot.style.background = 'var(--blue)';
    text.textContent = `Fine Mano ${state.roundNumber}`;
  } else if (state.phase === 'GAME_END') {
    dot.style.background = 'var(--gold)';
    text.textContent = 'Partita Finita';
  }

  const promptEl = document.getElementById('turn-prompt');
  if (state.phase === 'PLAYER_TURN') {
    promptEl.innerHTML = 'Premi <strong>HIT</strong> per pescare o <strong>STAY</strong> per fermarti.';
  } else if (state.phase === 'AI_TURN') {
    promptEl.textContent = "L'IA sta decidendo...";
  } else if (state.phase === 'CHOOSING_TARGET') {
    promptEl.textContent = currentPlayer.isHuman ? 'Scegli il bersaglio nella finestra.' : "L'IA sta scegliendo il bersaglio...";
  } else {
    promptEl.innerHTML = '&nbsp;';
  }

  const canAct = state.phase === 'PLAYER_TURN' && human.status === 'ACTIVE';
  document.getElementById('btn-hit').disabled = !canAct;
  document.getElementById('btn-stay').disabled = !canAct;
}

function showHumanTargetModal(effect) {
  const isFreeze = effect.type === 'FREEZE';
  document.getElementById('target-modal-title').textContent = isFreeze ? '❄️ Scegli chi congelare' : '🎲 Scegli il bersaglio';
  document.getElementById('target-modal-sub').textContent = isFreeze
    ? 'Il giocatore scelto è costretto a fermarsi subito con il punteggio attuale.'
    : 'Il giocatore scelto dovrà pescare 3 carte di fila.';

  const human = state.players.find(p => p.isHuman);
  const ai = state.players.find(p => !p.isHuman);
  const selfBtn = document.getElementById('target-btn-self');
  const oppBtn = document.getElementById('target-btn-opponent');

  selfBtn.textContent = state.p1Name;
  oppBtn.textContent = 'IA';
  selfBtn.onclick = () => { document.getElementById('target-modal').close(); resolveTargetSelection(human.id); };
  oppBtn.onclick = () => { document.getElementById('target-modal').close(); resolveTargetSelection(ai.id); };

  document.getElementById('target-modal').showModal();
}

function showRoundEndModal(gains) {
  const human = state.players.find(p => p.isHuman);
  const ai = state.players.find(p => !p.isHuman);
  document.getElementById('round-end-title').textContent = `Fine Mano ${state.roundNumber}`;
  document.getElementById('round-end-summary').innerHTML = `
    <div class="summary-row"><span class="name">${state.p1Name}</span><span class="gain">+${gains[human.id] || 0}</span><span class="total">tot. ${human.score}</span></div>
    <div class="summary-row"><span class="name">IA</span><span class="gain">+${gains[ai.id] || 0}</span><span class="total">tot. ${ai.score}</span></div>
  `;
  document.getElementById('round-end-modal').showModal();
}

function showGameEndModal(winner) {
  const human = state.players.find(p => p.isHuman);
  const ai = state.players.find(p => !p.isHuman);
  document.getElementById('game-end-title').textContent = winner.isHuman ? '🏆 Hai Vinto!' : '🤖 Ha Vinto la IA';
  document.getElementById('game-end-summary').innerHTML = `
    <div class="summary-row"><span class="name">${state.p1Name}</span><span class="total">${human.score} pt</span></div>
    <div class="summary-row"><span class="name">IA</span><span class="total">${ai.score} pt</span></div>
  `;
  document.getElementById('game-end-modal').showModal();
}

/* =========================================================
   7. SCREEN NAVIGATION & CONTROLS
   ========================================================= */
function navigateScreen(screenId) {
  document.querySelectorAll('.view-screen').forEach(el => el.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function openSetupScreen() {
  loadSavedProfile();
  navigateScreen('screen-setup');
}

function onHitClick() {
  initAudio();
  const idx = state.players.findIndex(p => p.isHuman);
  if (idx !== -1 && state.phase === 'PLAYER_TURN') drawCard(idx);
}

function onStayClick() {
  initAudio();
  const idx = state.players.findIndex(p => p.isHuman);
  if (idx !== -1 && state.phase === 'PLAYER_TURN') playerStay(idx);
}

function onNextRoundClick() {
  document.getElementById('round-end-modal').close();
  proceedToNextRound();
}

function onNewGameFromEndClick() {
  document.getElementById('game-end-modal').close();
  startNewGame();
}

function confirmExitToHome() {
  document.getElementById('exit-confirm-dialog').showModal();
}

function restartMatch() {
  document.getElementById('restart-confirm-dialog').showModal();
}

function confirmRestartMatch() {
  document.getElementById('restart-confirm-dialog').close();
  startNewGame();
}

function exitApp() {
  if (confirm('Vuoi chiudere il gioco?')) window.close();
}

/* =========================================================
   8. PROFILE, DIFFICULTY & GEMINI SETTINGS
   ========================================================= */
function saveProfile() {
  const name = document.getElementById('p1-name-input').value.trim() || 'Giocatore';
  localStorage.setItem('flip7_profile', JSON.stringify({ p1Name: name }));
}

function loadSavedProfile() {
  const raw = localStorage.getItem('flip7_profile');
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (saved.p1Name) document.getElementById('p1-name-input').value = saved.p1Name;
  } catch (e) { /* ignore */ }
}

function onDifficultyChange(mode) {
  updateAiModelCaption(mode);
}

function formatModelLabel(modelId) {
  return modelId.split('-').map(part => /^\d/.test(part) ? part : (part.charAt(0).toUpperCase() + part.slice(1))).join(' ');
}

async function discoverLatestFlashModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!res.ok) return [];
    const data = await res.json();
    if (!data.models) return [];

    const flashModels = data.models
      .map(m => m.name.replace('models/', ''))
      .filter(name => {
        const lower = name.toLowerCase();
        return lower.includes('flash') &&
               !lower.includes('pro') &&
               !lower.includes('lite') &&
               !lower.includes('preview') &&
               !lower.includes('embed') &&
               !lower.includes('tts') &&
               !lower.includes('imagen') &&
               !lower.includes('latest') &&
               /\d/.test(lower);
      })
      .sort()
      .reverse();

    return flashModels.slice(0, 3);
  } catch (e) {
    console.warn('Auto-discovery flash models failed:', e);
    return [];
  }
}

async function updateAiModelCaption(mode) {
  const caption = document.getElementById('ai-model-caption');
  if (mode !== 'gemini') { caption.style.display = 'none'; return; }
  caption.style.display = 'block';
  const apiKey = localStorage.getItem('flip7_gemini_key') || '';
  if (!apiKey) {
    caption.textContent = "Il modello Flash più recente verrà rilevato all'avvio (serve una chiave API in Opzioni).";
    return;
  }
  caption.textContent = 'Rilevamento modello più recente...';
  if (!state.discoveredFlashModels || state.discoveredFlashModels.length === 0) {
    state.discoveredFlashModels = await discoverLatestFlashModels(apiKey);
  }
  caption.textContent = (state.discoveredFlashModels && state.discoveredFlashModels.length > 0)
    ? formatModelLabel(state.discoveredFlashModels[0])
    : 'Nessun modello Flash rilevato, verrà usato un fallback.';
}

function openSettingsModal() {
  document.getElementById('gemini-key-input').value = localStorage.getItem('flip7_gemini_key') || '';
  document.getElementById('sound-select').value = state.settings.soundEnabled ? 'on' : 'off';
  document.getElementById('ai-test-result').textContent = '';
  document.getElementById('settings-modal').showModal();
}

function saveGeminiKey(val) {
  localStorage.setItem('flip7_gemini_key', val.trim());
  state.discoveredFlashModels = [];
  showToast('Chiave salvata.');
}

function saveSoundSetting(val) {
  state.settings.soundEnabled = val === 'on';
  localStorage.setItem('flip7_sound', val);
}

async function testAiConnection() {
  const resultEl = document.getElementById('ai-test-result');
  const apiKey = document.getElementById('gemini-key-input').value.trim() || localStorage.getItem('flip7_gemini_key') || '';
  if (!apiKey) { resultEl.style.color = '#ef4444'; resultEl.textContent = 'Inserisci prima una chiave API.'; return; }
  resultEl.style.color = 'var(--muted)';
  resultEl.textContent = 'Test in corso...';
  state.discoveredFlashModels = [];
  const models = await discoverLatestFlashModels(apiKey);
  if (models.length > 0) {
    state.discoveredFlashModels = models;
    resultEl.style.color = '#4ade80';
    resultEl.textContent = 'Disponibili: ' + models.map(formatModelLabel).join(', ');
  } else {
    resultEl.style.color = '#ef4444';
    resultEl.textContent = 'Nessun modello Flash disponibile. Verifica la chiave.';
  }
}

/* =========================================================
   9. STATS
   ========================================================= */
const STATS_CATEGORIES = [
  { key: 'easy', label: 'Facile (Prudente)' },
  { key: 'normal', label: 'Normale (Bilanciato)' },
  { key: 'hard', label: 'Difficile (Calcolatore)' },
  { key: 'gemini', label: 'AI Suprema (Gemini)' }
];

function defaultStats() {
  const categories = {};
  STATS_CATEGORIES.forEach(c => { categories[c.key] = { wins: 0, losses: 0, total: 0 }; });
  return { total: 0, categories };
}

function loadStats() {
  const raw = localStorage.getItem('flip7_stats');
  if (!raw) return defaultStats();
  try {
    const parsed = JSON.parse(raw);
    const base = defaultStats();
    return { total: parsed.total || 0, categories: Object.assign(base.categories, parsed.categories) };
  } catch (e) {
    return defaultStats();
  }
}

function saveGameStats(winnerSide) {
  const stats = loadStats();
  const cat = state.mode;
  if (!stats.categories[cat]) stats.categories[cat] = { wins: 0, losses: 0, total: 0 };
  stats.total++;
  stats.categories[cat].total++;
  if (winnerSide === 'human') stats.categories[cat].wins++; else stats.categories[cat].losses++;
  localStorage.setItem('flip7_stats', JSON.stringify(stats));
}

function openStatsModal() {
  const stats = loadStats();
  const rows = STATS_CATEGORIES.map(c => {
    const s = stats.categories[c.key];
    const winRate = s.total > 0 ? Math.round((s.wins / s.total) * 100) : 0;
    return `<div class="stat-block">
      <div class="stat-title">${c.label}</div>
      <div class="stat-row"><span>Partite: ${s.total}</span><span style="color:var(--gold);">Vinte: ${s.wins}</span><span style="color:#ef4444;">Perse: ${s.losses}</span><span>${winRate}%</span></div>
    </div>`;
  }).join('');

  document.getElementById('stats-summary').innerHTML = `
    <div class="stat-block"><strong>Partite Totali:</strong> ${stats.total}</div>
    ${rows}
  `;
  document.getElementById('stats-modal').showModal();
}

function resetStats() {
  if (confirm('Vuoi azzerare tutte le statistiche?')) {
    localStorage.removeItem('flip7_stats');
    openStatsModal();
    showToast('Statistiche azzerate.');
  }
}

/* =========================================================
   10. TOAST
   ========================================================= */
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* =========================================================
   11. PWA INSTALL (iOS & Android)
   ========================================================= */
const isIOSDevice = () => {
  return (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) && !window.MSStream;
};

const isRunningStandalone = () => {
  return ('standalone' in window.navigator && window.navigator.standalone === true) ||
         window.matchMedia('(display-mode: standalone)').matches ||
         window.matchMedia('(display-mode: fullscreen)').matches;
};

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredAndroidPrompt = e;
  if (!isRunningStandalone()) {
    document.getElementById('android-install-banner').style.display = 'flex';
  }
});

function triggerAndroidInstall() {
  if (deferredAndroidPrompt) {
    deferredAndroidPrompt.prompt();
    deferredAndroidPrompt.userChoice.then((choice) => {
      if (choice.outcome === 'accepted') {
        document.getElementById('android-install-banner').style.display = 'none';
      }
      deferredAndroidPrompt = null;
    });
  }
}

function dismissIosBanner() {
  document.getElementById('ios-install-banner').style.display = 'none';
  sessionStorage.setItem('flip7_ios_dismissed', 'true');
}

window.addEventListener('DOMContentLoaded', () => {
  loadSavedProfile();
  const savedSound = localStorage.getItem('flip7_sound');
  if (savedSound) state.settings.soundEnabled = savedSound === 'on';

  const iosBannerDismissed = sessionStorage.getItem('flip7_ios_dismissed');
  if (isIOSDevice() && !isRunningStandalone() && !iosBannerDismissed) {
    document.getElementById('ios-install-banner').style.display = 'flex';
  }
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(err => console.error(err));
  });
}

/* =========================================================
   12. PULL-TO-REFRESH (force a fresh reload + cache update)
   ========================================================= */
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
    console.warn('Cache refresh cleanup failed:', e);
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
    if (refreshing) return;
    if (document.querySelector('dialog[open]')) return;
    if (e.touches.length !== 1) return;
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
