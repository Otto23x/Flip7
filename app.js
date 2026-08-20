/**
 * Flip 7 AI - Pure Vanilla JavaScript Engine & App (Single Static Layout)
 */

(function () {
  'use strict';

  // --- GAME CONSTANTS & STATE ---
  const DEFAULT_SETTINGS = {
    aiLevel: 'NORMAL',
    soundEnabled: true,
    aiDelayMinMs: 700,
    aiDelayMaxMs: 1400
  };

  let state = {
    drawPile: [],
    discardPile: [],
    usedCards: [],
    players: [],
    currentPlayerIndex: 0,
    dealerIndex: 0,
    roundNumber: 1,
    phase: 'SETUP', // IN-GAME PERMANENT
    pendingEffects: [],
    currentPendingEffect: null,
    winnerId: null,
    settings: { ...DEFAULT_SETTINGS },
    logs: [],
    currentBanner: {
      icon: '📢',
      text: 'Benvenuto in Flip 7 AI!',
      sub: 'Premi "Nuova Partita" o effettua la prima pescata.',
      actionHTML: ''
    }
  };

  // --- AUDIO SYNTHESIZER (Web Audio API) ---
  let audioCtx = null;

  function initAudio() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
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

      const osc2 = audioCtx.createOscillator();
      const gain2 = audioCtx.createGain();
      osc2.type = 'square';
      osc2.frequency.setValueAtTime(140, now);
      osc2.frequency.linearRampToValueAtTime(40, now + 0.4);

      gain2.gain.setValueAtTime(0.2, now);
      gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.4);

      osc2.connect(gain2);
      gain2.connect(audioCtx.destination);

      osc2.start(now);
      osc2.stop(now + 0.4);
    } catch (e) {
      console.log('Audio error:', e);
    }
  }

  // --- DOM ELEMENTS ---
  const elements = {
    btnRules: document.getElementById('btn-rules'),
    headerHumanScore: document.getElementById('header-human-score'),
    headerAiScore: document.getElementById('header-ai-score'),
    headerRoundNum: document.getElementById('header-round-num'),

    eventBannerIcon: document.getElementById('event-banner-icon'),
    eventBannerText: document.getElementById('event-banner-text'),
    eventBannerSub: document.getElementById('event-banner-sub'),
    eventBannerAction: document.getElementById('event-banner-action'),

    aiArea: document.getElementById('ai-area'),
    aiStatusBadge: document.getElementById('ai-status-badge'),
    aiTotalScore: document.getElementById('ai-total-score'),
    aiRoundScore: document.getElementById('ai-round-score'),
    aiUniqueCount: document.getElementById('ai-unique-count'),
    aiCards: document.getElementById('ai-cards'),
    aiThinking: document.getElementById('ai-thinking'),

    humanArea: document.getElementById('human-area'),
    humanStatusBadge: document.getElementById('human-status-badge'),
    humanTotalScore: document.getElementById('human-total-score'),
    humanRoundScore: document.getElementById('human-round-score'),
    humanUniqueCount: document.getElementById('human-unique-count'),
    humanCards: document.getElementById('human-cards'),

    deckCount: document.getElementById('deck-count'),
    discardCount: document.getElementById('discard-count'),
    controlsHuman: document.getElementById('controls-human'),
    btnStartGame: document.getElementById('btn-start-game'),
    btnHit: document.getElementById('btn-hit'),
    btnStay: document.getElementById('btn-stay'),
    btnNextRound: document.getElementById('btn-next-round'),
    btnRestartGame: document.getElementById('btn-restart-game'),
    logContainer: document.getElementById('log-container'),

    btnLevels: document.querySelectorAll('.btn-level'),
    toggleSound: document.getElementById('toggle-sound'),

    modalRules: document.getElementById('modal-rules'),
    btnCloseRules: document.getElementById('btn-close-rules'),
    btnConfirmRules: document.getElementById('btn-confirm-rules')
  };

  // --- ENGINE LOGIC & DECK GENERATION ---
  function createDeck() {
    const deck = [];
    let idCounter = 1;

    for (let val = 0; val <= 12; val++) {
      const copies = val === 0 ? 1 : val;
      for (let c = 0; c < copies; c++) {
        deck.push({
          id: `card-num-${val}-${c}-${idCounter++}`,
          type: 'NUMBER',
          value: val
        });
      }
    }

    deck.push({ id: `card-mod-plus2-${idCounter++}`, type: 'MODIFIER', effect: 'PLUS_TWO' });
    deck.push({ id: `card-mod-mult2-${idCounter++}`, type: 'MODIFIER', effect: 'MULTIPLIER_TWO' });

    for (let i = 0; i < 3; i++) {
      deck.push({ id: `card-act-freeze-${i}-${idCounter++}`, type: 'ACTION', effect: 'FREEZE' });
      deck.push({ id: `card-act-flip3-${i}-${idCounter++}`, type: 'ACTION', effect: 'FLIP_THREE' });
      deck.push({ id: `card-act-sc-${i}-${idCounter++}`, type: 'ACTION', effect: 'SECOND_CHANCE' });
    }

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

  function calculateRoundScore(player) {
    if (player.status === 'BUSTED') {
      return { score: 0, isFlip7: false, isBust: true };
    }

    const uniqueNumbers = new Set();
    let numberSum = 0;

    for (const card of player.numberCards) {
      if (card.value !== undefined) {
        uniqueNumbers.add(card.value);
        numberSum += card.value;
      }
    }

    const isFlip7 = uniqueNumbers.size >= 7;
    const hasMultiplierTwo = player.modifierCards.some(c => c.effect === 'MULTIPLIER_TWO');
    const plusTwoCount = player.modifierCards.filter(c => c.effect === 'PLUS_TWO').length;

    let baseScore = numberSum;
    if (hasMultiplierTwo) baseScore *= 2;

    let totalRoundScore = baseScore + (plusTwoCount * 2);
    if (isFlip7) totalRoundScore += 15;

    return { score: totalRoundScore, isFlip7, isBust: false };
  }

  function countUniqueNumbers(player) {
    const set = new Set();
    for (const c of player.numberCards) {
      if (c.value !== undefined) set.add(c.value);
    }
    return set.size;
  }

  function setBanner(icon, text, sub = '', actionHTML = '') {
    state.currentBanner = { icon, text, sub, actionHTML };
    elements.eventBannerIcon.textContent = icon;
    elements.eventBannerText.textContent = text;
    elements.eventBannerSub.textContent = sub;
    elements.eventBannerAction.innerHTML = actionHTML;
  }

  function addLog(text, type = 'info') {
    const logItem = {
      id: `log-${Date.now()}-${Math.random()}`,
      timestamp: Date.now(),
      text,
      type
    };
    state.logs = [logItem, ...state.logs].slice(0, 50);
    renderLogs();
  }

  function rebuildDeckIfNeeded() {
    if (state.drawPile.length > 0) return;

    const activeTableCards = new Set();
    for (const p of state.players) {
      for (const c of p.numberCards) activeTableCards.add(c.id);
      for (const c of p.modifierCards) activeTableCards.add(c.id);
      if (p.secondChanceCard) activeTableCards.add(p.secondChanceCard.id);
    }

    const cardsToShuffle = [...state.discardPile, ...state.usedCards].filter(
      c => !activeTableCards.has(c.id)
    );

    state.drawPile = shuffle(cardsToShuffle);
    state.discardPile = [];
    state.usedCards = state.usedCards.filter(c => activeTableCards.has(c.id));
    addLog('Mazzo esaurito: rimescolate le carte scartate!', 'warn');
  }

  // --- GAME FLOW ACTIONS ---
  function startNewGame() {
    initAudio();
    const deck = shuffle(createDeck());

    state.drawPile = deck;
    state.discardPile = [];
    state.usedCards = [];
    state.players = [
      {
        id: 'player-human',
        name: 'Giocatore',
        isHuman: true,
        score: 0,
        roundScore: 0,
        status: 'ACTIVE',
        numberCards: [],
        modifierCards: [],
        secondChanceCard: undefined,
        uniqueNumberCount: 0
      },
      {
        id: 'player-ai',
        name: 'IA (Flip 7 Bot)',
        isHuman: false,
        score: 0,
        roundScore: 0,
        status: 'ACTIVE',
        numberCards: [],
        modifierCards: [],
        secondChanceCard: undefined,
        uniqueNumberCount: 0
      }
    ];
    state.currentPlayerIndex = 0;
    state.dealerIndex = 0;
    state.roundNumber = 1;
    state.phase = 'SETUP';
    state.pendingEffects = [];
    state.currentPendingEffect = null;
    state.winnerId = null;
    state.logs = [];

    addLog('Nuova partita avviata!', 'info');
    startRound();
  }

  function startRound() {
    state.players.forEach(p => {
      p.roundScore = 0;
      p.status = 'ACTIVE';
      p.numberCards = [];
      p.modifierCards = [];
      p.secondChanceCard = undefined;
      p.uniqueNumberCount = 0;
    });

    state.discardPile = [...state.discardPile, ...state.usedCards];
    state.usedCards = [];
    state.pendingEffects = [];
    state.currentPendingEffect = null;

    rebuildDeckIfNeeded();

    const startIndex = (state.dealerIndex + 1) % state.players.length;
    for (let i = 0; i < state.players.length; i++) {
      const pIdx = (startIndex + i) % state.players.length;
      dealInitialCard(pIdx);
    }

    state.currentPlayerIndex = (state.dealerIndex + 1) % state.players.length;
    const firstPlayer = state.players[state.currentPlayerIndex];
    state.phase = firstPlayer.isHuman ? 'PLAYER_TURN' : 'AI_TURN';

    if (firstPlayer.isHuman) {
      setBanner('👉', 'Tocca a te!', 'Premi HIT per pescare una carta o STAY per fermarti.');
    } else {
      setBanner('🤖', "Tocca all'IA", "L'IA sta per effettuare la sua mossa.");
    }

    addLog(`Inizio della Mano ${state.roundNumber}!`, 'info');
    renderUI();
    triggerAITurnIfNeeded();
  }

  function getCardName(card) {
    if (card.type === 'NUMBER') return `Numero ${card.value}`;
    if (card.type === 'MODIFIER') return card.effect === 'PLUS_TWO' ? 'Modificatore +2' : 'Modificatore x2';
    if (card.effect === 'FREEZE') return 'Azione FREEZE';
    if (card.effect === 'FLIP_THREE') return 'Azione FLIP THREE';
    return 'Azione SECOND CHANCE';
  }

  function dealInitialCard(playerIndex) {
    rebuildDeckIfNeeded();
    if (state.drawPile.length === 0) return;

    const card = state.drawPile.shift();
    state.usedCards.push(card);
    const player = state.players[playerIndex];

    addLog(`${player.name} riceve come carta iniziale: ${getCardName(card)}`, 'info');
    applyCardToPlayer(playerIndex, card);
  }

  function drawCard(playerIndex) {
    rebuildDeckIfNeeded();
    if (state.drawPile.length === 0) return;

    const player = state.players[playerIndex];
    if (player.status !== 'ACTIVE') return;

    const card = state.drawPile.shift();
    state.usedCards.push(card);

    addLog(`${player.name} pesca: ${getCardName(card)}`, 'action');
    applyCardToPlayer(playerIndex, card);
  }

  function applyCardToPlayer(playerIndex, card) {
    const player = state.players[playerIndex];

    if (card.type === 'NUMBER') {
      const hasDuplicate = player.numberCards.some(c => c.value === card.value);

      if (hasDuplicate) {
        if (player.secondChanceCard) {
          setBanner('🛡️', `${player.name} usa Second Chance!`, `Salvato dal BUST per il numero duplicato ${card.value}.`);
          addLog(`${player.name} ha pescato un ${card.value} duplicato, ma usa SECOND CHANCE per salvarsi dal BUST!`, 'warn');
          state.discardPile.push(card, player.secondChanceCard);
          player.secondChanceCard = undefined;
          checkTurnOrRoundEnd();
          return;
        } else {
          playBustSound();
          setBanner('💥', `${player.name} è andato in BUST!`, `Ha pescato il numero duplicato ${card.value} (0 punti per la mano).`);
          addLog(`${player.name} ha pescato un ${card.value} duplicato ed è andato in BUST!`, 'danger');
          player.status = 'BUSTED';
          player.roundScore = 0;
          checkTurnOrRoundEnd();
          return;
        }
      } else {
        player.numberCards.push(card);
        player.uniqueNumberCount = countUniqueNumbers(player);
        const scoreRes = calculateRoundScore(player);

        if (scoreRes.isFlip7) {
          setBanner('🎉', `FLIP 7 per ${player.name}!`, `7 valori numerici unici raccolti (+15pt bonus).`);
          addLog(`🎉 ${player.name} ha ottenuto FLIP 7! Bonus di +15 punti!`, 'success');
          player.status = 'FLIP_7';
          player.roundScore = scoreRes.score;
          endRoundImmediatelyOnFlip7(playerIndex);
          return;
        } else {
          setBanner('🃏', `${player.name} pesca Numero ${card.value}`, `Mano potenziale: ${scoreRes.score}pt (${player.uniqueNumberCount}/7 unici).`);
          player.roundScore = scoreRes.score;
          checkTurnOrRoundEnd();
          return;
        }
      }
    }

    if (card.type === 'MODIFIER') {
      player.modifierCards.push(card);
      const scoreRes = calculateRoundScore(player);
      player.roundScore = scoreRes.score;
      setBanner('➕', `${player.name} pesca Modificatore!`, `Applicato alla mano potenziale (${scoreRes.score}pt).`);
      checkTurnOrRoundEnd();
      return;
    }

    if (card.type === 'ACTION') {
      if (card.effect === 'SECOND_CHANCE') {
        if (!player.secondChanceCard) {
          setBanner('🛡️', `${player.name} riceve Second Chance`, 'Ti proteggerà da un eventuale BUST.');
          addLog(`${player.name} riceve la carta SECOND CHANCE.`, 'info');
          player.secondChanceCard = card;
        } else {
          const recipient = state.players.find((p, idx) => idx !== playerIndex && !p.secondChanceCard && p.status === 'ACTIVE');
          if (recipient) {
            setBanner('🛡️', `${player.name} riassegna Second Chance`, `Assegnata a ${recipient.name}.`);
            addLog(`${player.name} possiede già Second Chance: la assegna a ${recipient.name}!`, 'info');
            recipient.secondChanceCard = card;
          } else {
            setBanner('🛡️', `Second Chance scartata`, 'Nessun destinatario valido.');
            addLog(`${player.name} possiede già Second Chance e non ci sono altri destinatari: scartata.`, 'warn');
            state.discardPile.push(card);
          }
        }
        checkTurnOrRoundEnd();
        return;
      }

      if (card.effect === 'FREEZE' || card.effect === 'FLIP_THREE') {
        const effect = {
          id: `effect-${Date.now()}-${Math.random()}`,
          type: card.effect,
          sourcePlayerId: player.id
        };

        state.pendingEffects.push(effect);
        state.phase = 'CHOOSING_TARGET';
        state.currentPendingEffect = effect;

        addLog(`${player.name} ha pescato ${getCardName(card)}! Scegli il bersaglio.`, 'warn');
        renderUI();
        triggerAITargetSelectionIfNeeded();
        return;
      }
    }
  }

  function resolveTargetSelection(targetPlayerId) {
    if (!state.currentPendingEffect) return;

    const effect = state.currentPendingEffect;
    state.pendingEffects = state.pendingEffects.filter(e => e.id !== effect.id);
    state.currentPendingEffect = null;

    const targetPlayer = state.players.find(p => p.id === targetPlayerId);
    if (!targetPlayer) return;

    if (effect.type === 'FREEZE') {
      setBanner('❄️', `FREEZE applicato a ${targetPlayer.name}!`, 'Costretto al STAY (punteggio bloccato).');
      addLog(`FREEZE applicato a ${targetPlayer.name}! Viene costretto al STAY.`, 'danger');
      targetPlayer.status = 'FREEZED';
      const scoreRes = calculateRoundScore(targetPlayer);
      targetPlayer.roundScore = scoreRes.score;
      checkTurnOrRoundEnd();
      return;
    }

    if (effect.type === 'FLIP_THREE') {
      setBanner('🎰', `FLIP THREE su ${targetPlayer.name}!`, 'Deve effettuare 3 pescate consecutive.');
      addLog(`FLIP THREE applicato a ${targetPlayer.name}! Deve pescare 3 carte.`, 'warn');
      const targetIdx = state.players.findIndex(p => p.id === targetPlayerId);
      processFlipThreeDraw(targetIdx, 3);
      return;
    }
  }

  function processFlipThreeDraw(targetIdx, remainingDraws) {
    if (remainingDraws <= 0) {
      checkTurnOrRoundEnd();
      return;
    }

    const targetPlayer = state.players[targetIdx];
    if (targetPlayer.status !== 'ACTIVE') {
      checkTurnOrRoundEnd();
      return;
    }

    drawCard(targetIdx);

    if (targetPlayer.status === 'BUSTED' || targetPlayer.status === 'FLIP_7') {
      return;
    }

    if (remainingDraws - 1 > 0 && targetPlayer.status === 'ACTIVE') {
      processFlipThreeDraw(targetIdx, remainingDraws - 1);
    } else {
      checkTurnOrRoundEnd();
    }
  }

  function playerStay(playerIndex) {
    const player = state.players[playerIndex];
    if (player.status !== 'ACTIVE') return;

    if (player.numberCards.length === 0 && player.modifierCards.length === 0) {
      addLog(`${player.name} non può fare STAY senza carte!`, 'warn');
      return;
    }

    const scoreRes = calculateRoundScore(player);
    setBanner('🛡️', `${player.name} fa STAY`, `Punteggio mano salvato: ${scoreRes.score}pt.`);
    addLog(`${player.name} ha scelto STAY! Punteggio mano: ${scoreRes.score}`, 'info');
    player.status = 'STAYED';
    player.roundScore = scoreRes.score;

    checkTurnOrRoundEnd();
  }

  function checkTurnOrRoundEnd() {
    if (state.pendingEffects.length > 0 && !state.currentPendingEffect) {
      state.currentPendingEffect = state.pendingEffects[0];
      state.phase = 'CHOOSING_TARGET';
      renderUI();
      triggerAITargetSelectionIfNeeded();
      return;
    }

    const activePlayers = state.players.filter(p => p.status === 'ACTIVE');

    if (activePlayers.length === 0) {
      endRound();
      return;
    }

    let nextIdx = (state.currentPlayerIndex + 1) % state.players.length;
    while (state.players[nextIdx].status !== 'ACTIVE') {
      nextIdx = (nextIdx + 1) % state.players.length;
    }

    state.currentPlayerIndex = nextIdx;
    const nextPlayer = state.players[nextIdx];
    state.phase = nextPlayer.isHuman ? 'PLAYER_TURN' : 'AI_TURN';

    if (nextPlayer.isHuman) {
      setBanner('👉', 'Tocca a te!', 'Premi HIT per pescare una carta o STAY per fermarti.');
    } else {
      setBanner('🤖', "Tocca all'IA", "L'IA sta valutando la propria mossa...");
    }

    renderUI();
    triggerAITurnIfNeeded();
  }

  function endRoundImmediatelyOnFlip7(winnerIdx) {
    state.players.forEach((p, idx) => {
      if (idx === winnerIdx) {
        p.score += p.roundScore;
      } else if (p.status === 'BUSTED') {
        p.roundScore = 0;
      } else {
        const res = calculateRoundScore(p);
        p.roundScore = res.score;
        p.score += res.score;
      }
    });

    state.phase = 'ROUND_END';
    setBanner('🎉', `Fine Mano ${state.roundNumber} (FLIP 7)!`, 'Punteggi registrati. Premi "Prossima Mano" per continuare.');
    addLog(`Fine mano ${state.roundNumber} per Flip 7!`, 'success');
    checkGameOver();
    renderUI();
  }

  function endRound() {
    state.players.forEach(p => {
      if (p.status === 'BUSTED') {
        p.roundScore = 0;
      } else {
        const res = calculateRoundScore(p);
        p.roundScore = res.score;
        p.score += res.score;
      }
    });

    state.phase = 'ROUND_END';
    setBanner('🏁', `Fine Mano ${state.roundNumber}!`, 'Tutti i giocatori sono fermi o sballati. Premi "Prossima Mano" per continuare.');
    addLog(`Fine della Mano ${state.roundNumber}! Punteggi aggiornati.`, 'info');
    checkGameOver();
    renderUI();
  }

  function checkGameOver() {
    const targetScore = 200;
    const reachedPlayers = state.players.filter(p => p.score >= targetScore);

    if (reachedPlayers.length > 0) {
      const sorted = [...state.players].sort((a, b) => b.score - a.score);
      if (sorted[0].score > sorted[1].score) {
        const winner = sorted[0];
        setBanner('🏆', `PARTITA FINITA! ${winner.name} ha Vinto!`, `Punteggio finale: ${winner.score} punti.`);
        addLog(`🏆 ${winner.name} ha vinto la partita con ${winner.score} punti!`, 'success');
        state.phase = 'GAME_END';
        state.winnerId = winner.id;
      } else {
        setBanner('⚔️', 'Pareggio oltre 200 Punti!', 'Inizio mano di spareggio!');
        addLog(`Pareggio oltre 200 punti (${sorted[0].score}pt)! Inizio mano di spareggio!`, 'warn');
      }
    }
  }

  function proceedToNextRound() {
    if (state.phase !== 'ROUND_END') return;
    state.dealerIndex = (state.dealerIndex + 1) % state.players.length;
    state.roundNumber += 1;
    startRound();
  }

  // --- AI STRATEGY ENGINE ---
  function chooseAIAction(aiIndex) {
    const ai = state.players[aiIndex];
    const human = state.players.find(p => p.isHuman) || state.players[0];
    const level = state.settings.aiLevel;
    const uniqueCount = countUniqueNumbers(ai);
    const roundScore = ai.roundScore;

    if (level === 'EASY') {
      if (roundScore > 30 && Math.random() < 0.6) return 'STAY';
      return Math.random() < 0.5 ? 'STAY' : 'HIT';
    }

    if (level === 'NORMAL') {
      if (ai.score + roundScore >= 200) return 'STAY';
      if (ai.secondChanceCard && (roundScore < 25 || uniqueCount < 5)) return 'HIT';
      if (uniqueCount >= 5 && roundScore >= 20) return 'STAY';
      if (roundScore >= 28) return 'STAY';
      if (ai.score < human.score && human.status === 'STAYED' && human.roundScore > roundScore) return 'HIT';
      return 'HIT';
    }

    // HARD strategy
    if (ai.score + roundScore >= 200) return 'STAY';
    if (uniqueCount === 6 && (ai.secondChanceCard || roundScore < 40)) return 'HIT';
    if (ai.secondChanceCard && roundScore < 30) return 'HIT';
    if (uniqueCount >= 4 && roundScore >= 24) return 'STAY';
    if (roundScore >= 32) return 'STAY';
    return 'HIT';
  }

  function chooseAITarget(aiIndex, effect) {
    const ai = state.players[aiIndex];
    const human = state.players.find(p => p.isHuman);

    if (!human) return ai.id;
    if (effect.type === 'FREEZE') return human.status === 'ACTIVE' ? human.id : ai.id;
    if (effect.type === 'FLIP_THREE') return human.status === 'ACTIVE' ? human.id : ai.id;
    return human.id;
  }

  function triggerAITurnIfNeeded() {
    if (state.phase !== 'AI_TURN') return;

    const aiIdx = state.players.findIndex(p => !p.isHuman && p.status === 'ACTIVE');
    if (aiIdx === -1) return;

    elements.aiThinking.classList.remove('hidden');

    const minDelay = state.settings.aiDelayMinMs;
    const maxDelay = state.settings.aiDelayMaxMs;
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

    setTimeout(() => {
      elements.aiThinking.classList.add('hidden');
      const action = chooseAIAction(aiIdx);
      if (action === 'HIT') {
        drawCard(aiIdx);
      } else {
        playerStay(aiIdx);
      }
    }, delay);
  }

  function triggerAITargetSelectionIfNeeded() {
    if (state.phase !== 'CHOOSING_TARGET' || !state.currentPendingEffect) return;

    const effect = state.currentPendingEffect;
    const sourcePlayer = state.players.find(p => p.id === effect.sourcePlayerId);

    if (sourcePlayer && !sourcePlayer.isHuman) {
      const aiIdx = state.players.findIndex(p => p.id === sourcePlayer.id);
      setTimeout(() => {
        const targetId = chooseAITarget(aiIdx, effect);
        resolveTargetSelection(targetId);
      }, 1000);
    }
  }

  // --- RENDERING FUNCTIONS ---
  function createCardDOM(card) {
    const isNumber = card.type === 'NUMBER';
    const isModifier = card.type === 'MODIFIER';
    const isAction = card.type === 'ACTION';

    const cardDiv = document.createElement('div');
    cardDiv.className = `card-item ${
      isNumber ? 'card-number' : isModifier ? 'card-modifier' : 'card-action'
    }`;

    let topText = isNumber ? card.value : isModifier ? (card.effect === 'PLUS_TWO' ? '+2' : 'x2') : '⚡';
    let badgeText = isNumber ? 'NUM' : isModifier ? 'MOD' : 'ACT';

    let centerHTML = '';
    if (isNumber) {
      centerHTML = `<div class="text-3xl sm:text-4xl font-black text-center my-auto">${card.value}</div>`;
    } else if (isModifier) {
      centerHTML = `<div class="text-2xl sm:text-3xl font-black text-center my-auto">${card.effect === 'PLUS_TWO' ? '+2' : 'x2'}</div>`;
    } else if (isAction) {
      let actLabel = card.effect === 'FREEZE' ? 'FREEZE' : card.effect === 'FLIP_THREE' ? 'FLIP 3' : '2ND CHANCE';
      centerHTML = `<div class="text-[11px] font-bold text-center uppercase tracking-wider my-auto">${actLabel}</div>`;
    }

    cardDiv.innerHTML = `
      <div class="flex justify-between items-center text-xs font-bold">
        <span>${topText}</span>
        <span class="px-1 py-0.5 rounded text-[9px] bg-black/40">${badgeText}</span>
      </div>
      ${centerHTML}
      <div class="text-[9px] text-center opacity-80 truncate">${getCardName(card)}</div>
    `;

    return cardDiv;
  }

  function renderUI() {
    const human = state.players.find(p => p.isHuman);
    const ai = state.players.find(p => !p.isHuman);

    if (human && ai) {
      elements.headerHumanScore.textContent = human.score;
      elements.headerAiScore.textContent = ai.score;
      elements.headerRoundNum.textContent = `Mano ${state.roundNumber}`;

      // AI Area Render
      elements.aiTotalScore.textContent = `${ai.score} pt`;
      elements.aiRoundScore.textContent = `${ai.roundScore} pt`;
      elements.aiUniqueCount.textContent = ai.uniqueNumberCount;
      renderStatusBadge(elements.aiStatusBadge, ai.status, ai.roundScore);

      elements.aiCards.innerHTML = '';
      ai.numberCards.forEach(c => elements.aiCards.appendChild(createCardDOM(c)));
      ai.modifierCards.forEach(c => elements.aiCards.appendChild(createCardDOM(c)));
      if (ai.secondChanceCard) elements.aiCards.appendChild(createCardDOM(ai.secondChanceCard));

      // Human Area Render
      elements.humanTotalScore.textContent = `${human.score} pt`;
      elements.humanRoundScore.textContent = `${human.roundScore} pt`;
      elements.humanUniqueCount.textContent = human.uniqueNumberCount;
      renderStatusBadge(elements.humanStatusBadge, human.status, human.roundScore);

      elements.humanCards.innerHTML = '';
      human.numberCards.forEach(c => elements.humanCards.appendChild(createCardDOM(c)));
      human.modifierCards.forEach(c => elements.humanCards.appendChild(createCardDOM(c)));
      if (human.secondChanceCard) elements.humanCards.appendChild(createCardDOM(human.secondChanceCard));
    }

    elements.deckCount.textContent = state.drawPile.length || 94;
    elements.discardCount.textContent = state.discardPile.length;

    // Target Selection Banner Render per Human (Senza Pop-up!)
    if (state.phase === 'CHOOSING_TARGET' && state.currentPendingEffect) {
      const source = state.players.find(p => p.id === state.currentPendingEffect.sourcePlayerId);
      if (source && source.isHuman) {
        const isFreeze = state.currentPendingEffect.type === 'FREEZE';
        const title = isFreeze ? 'Scegli chi congelare con FREEZE:' : 'Scegli il bersaglio di FLIP THREE:';
        let actionButtonsHTML = '<div class="flex items-center space-x-2">';
        state.players.filter(p => p.status === 'ACTIVE').forEach(p => {
          actionButtonsHTML += `<button data-target-id="${p.id}" class="btn-target-select px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-white text-xs font-bold rounded-lg shadow">${p.isHuman ? 'Te stesso' : 'IA'}</button>`;
        });
        actionButtonsHTML += '</div>';

        setBanner(isFreeze ? '❄️' : '🎰', title, 'Seleziona direttamente dal banner in alto.', actionButtonsHTML);
      }
    }

    // Controls visibility
    if (state.phase === 'PLAYER_TURN' && human && human.status === 'ACTIVE') {
      elements.controlsHuman.classList.remove('hidden');
    } else {
      elements.controlsHuman.classList.add('hidden');
    }

    if (state.phase === 'ROUND_END') {
      elements.btnNextRound.classList.remove('hidden');
    } else {
      elements.btnNextRound.classList.add('hidden');
    }

    if (state.phase === 'GAME_END') {
      elements.btnRestartGame.classList.remove('hidden');
    } else {
      elements.btnRestartGame.classList.add('hidden');
    }
  }

  function renderStatusBadge(element, status, roundScore) {
    element.className = 'badge-status ';
    if (status === 'ACTIVE') {
      element.classList.add('status-active');
      element.textContent = 'ATTIVO';
    } else if (status === 'STAYED') {
      element.classList.add('status-stayed');
      element.textContent = `STAYED (${roundScore}pt)`;
    } else if (status === 'BUSTED') {
      element.classList.add('status-busted');
      element.textContent = 'BUSTED (0pt)';
    } else if (status === 'FREEZED') {
      element.classList.add('status-freezed');
      element.textContent = 'FREEZED';
    } else if (status === 'FLIP_7') {
      element.classList.add('status-flip7');
      element.textContent = '🎉 FLIP 7 (+15pt)';
    }
  }

  function renderLogs() {
    elements.logContainer.innerHTML = '';
    state.logs.forEach(log => {
      const logDiv = document.createElement('div');
      let textColor = 'text-slate-300';
      if (log.type === 'action') textColor = 'text-blue-300 font-medium';
      if (log.type === 'success') textColor = 'text-emerald-400 font-bold';
      if (log.type === 'warn') textColor = 'text-amber-400 font-medium';
      if (log.type === 'danger') textColor = 'text-red-400 font-bold';

      logDiv.className = `flex items-start space-x-2 ${textColor}`;
      const timeStr = new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      logDiv.innerHTML = `<span class="text-slate-600 text-[10px]">${timeStr}</span><span>${log.text}</span>`;
      elements.logContainer.appendChild(logDiv);
    });
  }

  // --- EVENT LISTENERS ---
  elements.btnStartGame.addEventListener('click', startNewGame);
  elements.btnHit.addEventListener('click', () => {
    initAudio();
    const humanIdx = state.players.findIndex(p => p.isHuman);
    if (humanIdx !== -1 && state.phase === 'PLAYER_TURN') drawCard(humanIdx);
  });
  elements.btnStay.addEventListener('click', () => {
    initAudio();
    const humanIdx = state.players.findIndex(p => p.isHuman);
    if (humanIdx !== -1 && state.phase === 'PLAYER_TURN') playerStay(humanIdx);
  });
  elements.btnNextRound.addEventListener('click', proceedToNextRound);
  elements.btnRestartGame.addEventListener('click', startNewGame);

  // Delegated Listener per Target Selection nel Banner
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-target-select');
    if (btn && btn.dataset.targetId) {
      resolveTargetSelection(btn.dataset.targetId);
    }
  });

  // Settings embedded at bottom
  elements.btnLevels.forEach(btn => {
    btn.addEventListener('click', () => {
      elements.btnLevels.forEach(b => {
        b.className = 'btn-level py-1 px-3 text-xs font-bold rounded-md text-slate-400 hover:text-white';
      });
      btn.className = 'btn-level py-1 px-3 text-xs font-bold rounded-md bg-amber-500 text-slate-950';
      state.settings.aiLevel = btn.dataset.level;
    });
  });

  elements.toggleSound.addEventListener('click', () => {
    state.settings.soundEnabled = !state.settings.soundEnabled;
    if (state.settings.soundEnabled) {
      elements.toggleSound.className = 'w-12 h-6 rounded-full bg-emerald-500 p-1 flex items-center justify-end transition-colors';
    } else {
      elements.toggleSound.className = 'w-12 h-6 rounded-full bg-slate-700 p-1 flex items-center justify-start transition-colors';
    }
  });

  // Rules Modal
  elements.btnRules.addEventListener('click', () => elements.modalRules.classList.remove('hidden'));
  elements.btnCloseRules.addEventListener('click', () => elements.modalRules.classList.add('hidden'));
  elements.btnConfirmRules.addEventListener('click', () => elements.modalRules.classList.add('hidden'));

  // Service Worker Registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(err => {
        console.log('SW Registration failed:', err);
      });
    });
  }

  // Initial Game Start
  startNewGame();
})();
