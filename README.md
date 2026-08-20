# Flip 7 — PWA (HTML, CSS & JavaScript puro)

Riscrittura completa dell'app, senza dipendenze esterne (niente CDN, niente framework): funziona interamente offline una volta installata.

## Avvio
Nessun build richiesto. Apri `index.html` in un browser moderno, oppure servilo con:
```bash
python3 -m http.server 8080
```

## Cosa è cambiato rispetto alla versione precedente
- **Nessuna dipendenza da CDN** (prima usava Tailwind da jsdelivr, che rompeva il funzionamento offline della PWA).
- **Icone reali** (SVG, coerenti dentro/fuori l'app) — prima il manifest puntava a PNG inesistenti.
- **Menu introduttivo** con logo, spiegazione rapida, regole, statistiche e opzioni.
- **Schermata di gioco compatta**: tutto in una sola schermata senza scroll, niente più pannelli sovrapposti — barra di stato in alto, le due mani al centro, HIT/STAY in basso.
- **Mazzo corretto**: 94 carte reali (prima ne mancavano 4 modificatori: +4, +6, +8, +10).
- **IA basata su probabilità reali**: calcola l'esatta probabilità di BUST guardando le carte rimaste nel mazzo, invece di soglie arbitrarie. Tre livelli (Facile/Normale/Difficile) più un quarto livello **AI Suprema** che usa Google Gemini (con la stessa chiave API impostabile in Opzioni), con rilevamento automatico del modello Flash più recente disponibile.
- **Statistiche per livello di avversario**, pull-to-refresh per forzare l'aggiornamento della cache, banner di installazione per Android e iOS.

## Struttura
- `index.html` — struttura, stile e schermate (home, setup, partita, finestre di dialogo).
- `app.js` — motore di gioco, IA, integrazione Gemini, rendering, logica PWA.
- `sw.js` — service worker per il funzionamento offline.
- `manifest.webmanifest` — configurazione PWA/installazione.
- `assets/` — logo e icone (SVG).
