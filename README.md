# Filotto — PWA (HTML, CSS e JavaScript puro)

Gioco di carte *push your luck* per 2 giocatori con carte da Scala 40: pesca per fare punti, fermati prima del **Doppione**, chiudi il **Filotto** con 7 carte diverse. Si gioca contro la CPU (3 livelli) oppure online con un amico tramite codice stanza.

Nessuna dipendenza esterna lato client (niente CDN, niente framework): una volta installata funziona interamente offline.

## Avvio rapido

Solo partite contro la CPU: apri `index.html` in un browser moderno, oppure servilo con:

```bash
python3 -m http.server 8080
```

Partite online (serve il server relay incluso, che serve anche l'app):

```bash
cd server
npm install
npm start          # http://localhost:8080 — porta configurabile con PORT
```

Aprendo l'app dallo stesso indirizzo del server, l'online funziona senza configurare nulla. Se invece l'app è pubblicata altrove (es. GitHub Pages) inserisci l'indirizzo del server in **Opzioni → Server per il gioco online** (es. `wss://filotto.tuodominio.it`).

### Deploy del server

Il `Dockerfile` in radice costruisce un'immagine che serve app e relay sulla stessa porta: va bene per Render, Fly.io, Railway o qualsiasi host che accetti un container Node. In alternativa basta un Node ≥ 18 con `node server/server.js`. Endpoint di controllo: `GET /health`.

## Regole in breve

- **Carte valore**: 2 mazzi francesi (104 carte). Asso = 1, dal 2 al 10 il valore stampato, J/Q/K = 10. I semi non contano.
- **Doppione**: peschi una carta con lo stesso valore di una che hai già (due 7, due Re…) e perdi i punti della mano.
- **Filotto**: 7 carte di valore diverso: +15 punti e la mano finisce subito per tutti.
- **Jolly** (4): vale 0, conta come carta diversa, non fa mai Doppione.
- **Modificatori**: +2/+4/+6/+8/+10 punti fissi; ×2 raddoppia la somma delle carte (non cumulabile).
- **Carte potere** (si risolvono da sole, quelle "contro" colpiscono sempre l'avversario):
  - ❄️ **Gelo** — l'avversario chiude subito la mano.
  - 🎲 **Pesca 3** — l'avversario pesca 3 carte di fila.
  - 🔄 **Scambio** — le carte valore dei due giocatori si scambiano.
  - 🛡️ **Salvagente** — annulla il tuo primo Doppione.
  - 👁️ **Sbircia** — vedi la prossima carta del mazzo prima di decidere.
  - 🏦 **Banca** — i punti che hai in quel momento restano tuoi anche se poi fai Doppione.
- **Traguardo** a scelta: 101, 201, 301, 401 o 501 punti. Vince chi lo raggiunge a fine mano; in parità si continua.

## Livelli CPU

| Livello | Stile | Come decide |
|---|---|---|
| Facile | Prudente | Si accontenta di 16–25 punti, stima il rischio "a occhio" senza contare le carte, usa Sbircia solo a volte e nel 15% dei casi sbaglia mossa. |
| Medio | Calcolatore | Valore atteso calcolato sulle carte davvero rimaste nel mazzo; usa Salvagente e Sbircia; prova a chiudere il Filotto. Ignora il tuo punteggio. |
| Difficile | Stratega | Come il Medio, più: rischia solo i punti non in Banca, legge la tua situazione (deve superarti se hai già chiuso, è obbligato a rischiare se stai per vincere), modula l'aggressività su distacco e traguardo. |

## Online: come funziona

- Il **server** (`server/server.js`, Node + `ws`) è un relay con stanze a codice di 4 caratteri: crea/entra/inoltra, più heartbeat e scadenza delle stanze vuote. Non contiene logica di gioco.
- L'**host** (chi crea la stanza) esegue il motore di gioco e invia all'ospite una fotografia dello stato dopo ogni aggiornamento (senza il mazzo: solo il conteggio, e la carta sbirciata solo se è sua).
- L'**ospite** invia solo le proprie decisioni (PESCA/STOP, prossima mano, richiesta di rivincita). L'annulla mossa è disponibile solo contro la CPU.
- Se uno dei due si disconnette, l'altro viene riportato alla Home con un avviso.

## Struttura

- `index.html` — struttura, stile e schermate (home, setup CPU, online, partita, finestre).
- `app.js` — motore di gioco, CPU a tre livelli, client online, rendering, logica PWA.
- `sw.js` — service worker per il funzionamento offline (rete prima, cache come riserva).
- `manifest.webmanifest` — configurazione PWA/installazione.
- `assets/` — logo e icone (SVG).
- `server/` — server statico + relay WebSocket per il gioco online.
- `Dockerfile` — immagine unica app + server.

## Nota sul nome

"Filotto" è una parola comune italiana (una serie vincente) scelta per non usare marchi registrati. Prima della pubblicazione sugli store verifica comunque la disponibilità del nome nelle banche dati marchi (UIBM/EUIPO) per la categoria giochi.
