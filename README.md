# Band Metronome

Metronom sincronizat pentru trupă, direct din browser (Android / Chrome). Toboșarul (Master) pornește
sesiunea, ceilalți intră cu un cod de 4 cifre sau scanând QR-ul. Fiecare telefon generează click-ul
local (Web Audio); prin rețea circulă doar sincronizarea ceasului și comenzile.

## Cum funcționează

- **Sincronizare ceas** (`src/sync/clockSync.ts`): ping-uri NTP către Master; din ultimele 40 de măsurători
  se păstrează cele mai rapide 30% și se ia mediana. Corecțiile mici se aplică treptat (max 0,5 ms/ping).
- **Cronologie** (`src/timeline.ts`): Master trimite segmente (start, BPM, măsură). Orice telefon calculează
  singur momentul fiecărui click. Schimbările de tempo intră pe următorul timp 1, cu minim 600 ms avans.
- **Motor audio** (`src/audio/engine.ts`): programare cu 300 ms în avans pe ceasul plăcii audio. Fiecare click
  e programat mai devreme cu latența căștilor Bluetooth, ca să se audă la momentul corect. Un zgomot
  la −80 dB ține legătura Bluetooth trează.
- **Flash-ul vizual** nu e întârziat (ecranul nu are latența Bluetooth-ului).

## Piese și setlist (Master → „Piese”)

- **Bibliotecă**: titlu, artist, număr de măsuri, count-in și o listă de schimbări pe măsuri
  (BPM, ritm ca `4/4` sau `7/8`, instrucțiune text). „Treptat” face accelerando/ritardando de la
  schimbarea de tempo anterioară până la măsura respectivă.
- **Setlist**: ordinea pieselor; „Următoarea ▶” încarcă piesa următoare. La finalul unei piese din setlist,
  următoarea se încarcă automat (oprită).
- **Pe ecranul tuturor**: secțiunea curentă, „Măsura 3 din 8”, măsura din piesă și, cu o măsură înainte
  de orice schimbare, banner „URMEAZĂ: …” și flash roșu pe fiecare bătaie.
- Biblioteca se salvează local pe telefonul Master (merge fără internet). Sincronizarea cu Firebase urmează.

## Calibrarea latenței Bluetooth

Fiecare combinație telefon + căști are altă latență (de obicei 150–300 ms). Setarea se salvează pe telefon.

1. **Calibrare prin atingere**: atingi ecranul pe click-urile din căști; dă o valoare aproximativă.
2. **Reglaj fin cu referință**: un telefon din sesiune rămâne fără Bluetooth (sună pe difuzor). Asculți cu o
   cască și difuzorul simultan și ajustezi cu ±1/±10 ms până cele două click-uri se aud ca unul.

Sfaturi: în setările Bluetooth ale telefonului alege un codec fix (AAC/SBC), nu „adaptive” (aptX Adaptive,
LDAC auto), altfel latența variază în timpul cântării. Toți pe aceeași rețea Wi-Fi sau pe hotspot-ul Master.

## Dezvoltare

```bash
npm install
npm run dev        # http://localhost:5173 (pe telefon e nevoie de HTTPS -> folosește build-ul de pe Pages)
npm test
npm run build
```

Semnalizarea folosește implicit serverul public PeerJS. Pentru un server propriu, setează la build
`VITE_PEER_HOST`, `VITE_PEER_PORT`, `VITE_PEER_PATH`, `VITE_PEER_SECURE`.

## Publicare

Workflow-ul `.github/workflows/deploy.yml` publică pe GitHub Pages. O singură dată: în GitHub,
**Settings → Pages → Source: GitHub Actions**.
