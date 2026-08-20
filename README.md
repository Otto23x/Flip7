# Flip 7 AI - Pure HTML, CSS & Vanilla JavaScript PWA

Applicazione web progressiva (PWA) installabile per giocare a Flip 7 contro un'IA, riscritta completamente senza l'utilizzo di Node, npm o strumenti di build.

---

## 🚀 Istruzioni di Avvio

Non è richiesto alcun processo di build o comando npm!

Puoi aprire direttamente il file [`index.html`](file:///Users/Roberto/.gemini/antigravity/scratch/flip7-ai/index.html) in qualsiasi browser web moderno, oppure servirlo tramite un semplice HTTP server:

```bash
# Esempio server locale con Python
python3 -m http.server 8080
```

Poi apri `http://localhost:8080` nel browser.

---

## 📂 Struttura del Progetto

- [`index.html`](file:///Users/Roberto/.gemini/antigravity/scratch/flip7-ai/index.html): Struttura HTML5 semantica e responsive per desktop e mobile.
- [`style.css`](file:///Users/Roberto/.gemini/antigravity/scratch/flip7-ai/style.css): Stili CSS custom per carte da gioco, animazioni e layout.
- [`app.js`](file:///Users/Roberto/.gemini/antigravity/scratch/flip7-ai/app.js): Motore di gioco pure Vanilla JS (gestione turno, mazzo 94 carte, calcolo punteggi, carte Azione/Modificatore, intelligenza artificiale a 3 difficoltà).
- [`sw.js`](file:///Users/Roberto/.gemini/antigravity/scratch/flip7-ai/sw.js): Service Worker per il funzionamento completamente offline.
- [`manifest.webmanifest`](file:///Users/Roberto/.gemini/antigravity/scratch/flip7-ai/manifest.webmanifest): Configurazione PWA per l'installazione su mobile e desktop.
