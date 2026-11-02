# canvas-mini

Koko ruudun taulukko-canvas, jota sinä ja AI-agentti muokkaatte yhdessä. Nolla riippuvuutta: Node 20+ ja selain.

```bash
npm start            # http://127.0.0.1:3210
npm test             # 18 testiä, mm. 2000 kierroksen undo/redo-fuzz
```

## Mitä tässä on

**Käyttöliittymä** — `<canvas>`-renderöity, virtualisoitu ruudukko (ei DOM-taulukkoa), Google Sheetsin käytös:
- A1-koordinaatit, nimiruutu (kirjoita `C23:D32` ↵), kaavarivi, välilehdet alhaalla, jäädytetyt rivit/sarakkeet
- zoom 30–400 % (Ctrl+rulla / trackpad-nipistys osoittimen kohdalle), skrollaa satoja tuhansia rivejä
- kaavan muokkaus: klikkaa/nuolinäppäile soluja → viittaukset lisätään, värikoodatut viitekehykset, toiselta välilehdeltä `Sheet!A1`
- valinta: raahaus, Shift, Ctrl-monivalinta, koko rivi/sarake; tilastot (Sum/Avg/Count) alapalkissa
- siirrä alue raahaamalla reunasta tai Ctrl+X/V → **yksi move-operaatio, viittaukset seuraavat**
- täyttökahva (sarjat + kaavojen suhteellinen siirto), Ctrl+D / Ctrl+R, Σ
- kopioi/liitä TSV (Sheets/Excel ↔), lihavointi, värit, tasaus, muistiinpanot, sarakeleveys + tuplaklikkaus autofit
- rivien/sarakkeiden lisäys/poisto (kontekstivalikko), undo/redo (tarkat käänteisoperaatiot)
- agentin muokkaukset välähtävät violettina + "agent"-kehys; välilehteen tulee piste jos muutos on muualla

**Nimetyt taulukot (jäsennelty data)** — sheetissä voi olla monta pientä taulukkoa missä kohtaa tahansa, otsikot ja muistiinpanot ympärillä:
- valitse alue (tai yksi solu → alue tunnistetaan) → ▦ tai oikea klikkaus *Create table* → nimi
- otsikkorivi = sarakkeet, loput = tietueet; kirjoita suoraan taulukon alle → taulukko kasvaa
- oikea klikkaus taulukossa: lisää rivi/sarake, poista tietue, nimeä, pura
- kaavoissa `=COUNTIF(Tehtävät[Tila],"auki")`; taulukot seuraavat siirtoja ja rivilisäyksiä
- teksti on ensiluokkaista: Alt+Enter rivinvaihto solussa, ↵ rivitys, tuplaklikkaus rivin reunaan = sovita korkeus
- agentti: `cm read @Tehtävät` → tietueet, `cm update Tehtävät 'Kytke servot' Tila=valmis`, `cm add …`; muutosvirta kertoo `⟨Tehtävät[Kytke servot].Tila⟩`

**Agentille** (`AGENT_SKILL.md`, CLI `bin/cm.mjs`):
- `cm changes` → vain muutokset edellisestä kerrasta, tekstinä: `B2: 4 → 10`, `calc: D6 196.8→271.8`, `MOVE A2:E5 → A8:E11`
- siirrot ja rivilisäykset raportoidaan rakenteellisina tapahtumina, ei satoina solumuutoksina
- milestone-diff on siirtotietoinen: siirretty data ei näy "poistettu + lisätty" -roskana
- `expect` → 409 jos käyttäjä ehti muuttaa solua; batchit atomisia
- `cm sel` = mitä käyttäjä on valinnut juuri nyt (äänikomennot: "laske nämä yhteen")

**Versiohallinta** — jokainen batch on versio (`data/log.jsonl`), milestonet (Ctrl+S) ovat nimettyjä snapshotteja, History-paneeli näyttää saman tekstivirran kuin agentti näkee, Diff korostaa muuttuneet solut ruudukossa, Restore palauttaa.

## Arkkitehtuuri

```
public/shared/          ← sama koodi selaimessa JA palvelimella
  a1.js                   osoitteet
  formula.js              tokenizer, Pratt-parseri, viitteiden uudelleenkirjoitus (ei eval)
  engine.js               laiska memoitu laskenta, ~50 funktiota, kehäviittaukset
  types/sheet.js          workbook-tila + opit: apply(state, op) → {inverse, changes}
  types/text.js           toinen canvas-tyyppi (todiste plugin-rakenteesta)
  types/index.js          rekisteri
public/canvases/<tyyppi>/view.js   selainnäkymä per tyyppi
public/app.js           shell: välilehdet, SSE-synkka, historia, milestonet
lib/store.js            versioitu oplog, atomiset batchit, recalc-diff, commitit
lib/format.js           token-säästeliäät tekstiesitykset agentille
server.js               node:http, REST + SSE + staattiset
```

Selain ajaa saman `apply`-funktion optimistisesti kuin palvelin → välitön UI, palvelin on totuus.
Muutos-tietueet syntyvät opeista itsestään, joten muutosvirta on aina semanttinen (move on move).

**Uusi canvas-tyyppi** (esim. teksti, kanban, kuva): `shared/types/x.js` (`create, apply, diff, describe, read`),
rekisteröi `types/index.js`:ään, tee `canvases/x/view.js` (`mount(root, ctx) → {remote, reload, unmount}`).
Versiointi, milestonet, muutosvirta, SSE ja agentin API tulevat ilmaiseksi.

Asetukset: `PORT`, `HOST` (oletus 127.0.0.1 — ei autentikointia), `CANVAS_DATA` (datahakemisto).
