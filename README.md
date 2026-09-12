# Hearthlands Online

An original browser-based settlement game for **3-6 human players**, implementing the base game's mechanics and the **2025 paired-player 5-6 extension**. Private rooms, guest names, real-time multiplayer, hidden hands, and saved seats. No accounts, paid services, external fonts, or copied publisher artwork.

## Start

Requires **Node.js 24 LTS** (pinned in `.node-version`). This uses Node's built-in SQLite engine without native-addon compilation.

```powershell
Set-Location C:\Users\amansha\hearthlands-online
fnm use
npm ci
npm start
```

Open **http://localhost:3000**. Create a room and share its six-letter code or invite link. The host starts once **3-6 connected players** have joined. On the same local network, friends use your computer's network address instead of `localhost`; the network must allow the chosen port.

Each browser profile has a private seat. To try multiple players on one computer, use separate browser profiles or different browsers. Chrome Incognito windows share storage with each other, so opening several Incognito windows does not create separate profiles. Opening the same seat on another device or tab transfers control to the new connection.

## Playing

The map is the placement control; no location dropdown is required. Choose **Road**, **Settlement**, or **City** from the piece tray above the island, then click/tap a highlighted path, corner, or existing settlement. Setup pieces, free roads, and the robber are selected automatically when required. A ghost preview and **Confirm placement** / **Cancel** controls let you inspect or change the location before anything is spent or sent. The island uses original landscape art, raised number tokens, and wooden-style pieces; terrain names are not printed across the hexes. Number tokens and probability dots remain visible. Player panels distinguish resource cards, development cards, longest-road length, and played knights.

Board selection uses screen-space touch tolerance, including thin vertical roads, and follows the actual zoom/pan transform. Dragging or pinching does not place a piece. Keyboard users can Tab to the board, move among legal targets with arrows/Home/End, press Enter/Space to preview, and Tab to the confirmation controls. Previewing and cancelling never consumes a request sequence or resource. A preview is not a saved placement; reloading cancels it.

The surrounding controls are purpose-built for play: compact player nameplates, physical-style resource/development cards, illustrated trade choices, player-colour trade targets, and bounded quantity steppers. Self-hosted Cinzel and Source Sans 3 fonts keep the table readable without external font requests. The map artwork is unchanged.

Dice use a six-faced roll-and-settle animation. A pending roll remains visibly unconfirmed on a slow connection; only the server response chooses its final faces. Reduced-motion settings replace tumbling with a quiet pending indication.

Open **? → Resource conversion** for an illustrated reference card showing the exact road, settlement, city-upgrade and development-card costs, plus 4:1 bank, 3:1 general-port and 2:1 matching-port exchanges. It is a read-only guide, not a card you buy or play.

### Shared pointers, map previews, and table controls

Everyone seated at a table can point, including players waiting for their turn. Shared cursors show each player's name and colour **only while pointing inside the map**. The **Cursors** toggle stops sharing your cursor and hides other cursors. Pings are separate, explicit signals and remain available.

| Control | What it does |
|---|---|
| **Point** or **P** | Toggle point mode, then click/tap a location to send a coloured ripple ping; never places a piece |
| **Alt-click** | Send a ping without switching tools |
| **Escape** | Leave point/build selection mode |
| **Undo / Ctrl+Z / Cmd+Z** | Undo an eligible current-turn placement; the keyboard shortcut cancels an unconfirmed preview first |
| **+ / - / percentage** | Zoom in, zoom out, or fit the island |
| **Drag / pinch** | Pan a zoomed island or pinch-to-zoom with Panzoom |
| **Ctrl/Cmd + wheel** | Zoom toward the pointer |
| **Sound / fullscreen** | Optional sounds (off by default) and a distraction-free table |

In the lobby, the host can **Shuffle island** as often as desired. Everyone sees the same persisted preview, and **the game starts on that exact map**. Joining/leaving preserves the map unless the room crosses the four/five-player board-size boundary. Five and six players share the expanded board size. Shuffling is unavailable after the game starts, so roads, resources, and settlements cannot be reset accidentally.

New islands use a **constrained resource shuffle**: identical terrain types never share an edge, including the two deserts on the larger island. The correct 19-/30-hex inventories, number-token counts and nonadjacent 6/8 rule are preserved. Randomized choices keep maps varied and allow deserts throughout the island; a bounded search with a verified fallback prevents pathological random sources from hanging the server. This is a map-generation preference, not a claim that the official rules prohibit matching neighbors or that every starting site is equally strong.

Existing saved boards and lobby previews are not rearranged during an update or reconnect. To use the new distribution in an existing lobby, the host must explicitly select **Shuffle island**; games already underway keep their original map.

Cursors and pings are ephemeral, room-scoped messages with separate rate limits. They do not advance the game, change resources, or write game saves. Cursors disappear when the pointer leaves the map; pings briefly linger so friends can see them. All markers clear when leaving a room, reconnecting, or changing maps, and expire when updates stop. Normalized board coordinates keep them aligned even when players use different zoom levels or screen sizes.

Point mode automatically turns off when your turn begins or a required placement step arrives, for admins and guests alike. If you deliberately enable it during placement, the interface explicitly says **You are pointing, not placing** and offers **Return to placement**. Pointing never silently replaces a build action.

### Placement undo (house rule)

**Undo** reverses eligible placements from the current activation, most recent first, with authoritative refunds and returned pieces. It is not a rewind of the whole game. The opportunity is saved with the game and can survive a reconnect/restart; a stale undo request cannot target a newer placement.

Starting settlements can be changed before their road hands control to the next player. Free-road undo restores the unfinished road obligation without returning the spent development card. Robber relocation can be changed only before stealing, another placement, or another irreversible action. Confirming a setup road ends that setup activation; the preview warns you beforehand.

Turn handoffs, completed games, dice/results, development-card actions, completed resource exchanges, stealing and other irreversible operations prevent rewinding earlier placements. Undo cannot reclaim another player's turn or reveal a stolen/drawn card and then reverse it. Activity keeps both the original placement and its reversal instead of erasing history.

### Core mechanics

| System | Behavior |
|---|---|
| Three or four | Standard 19-hex island, 19 cards of each resource, 25 development cards |
| Five or six | Expanded 30-hex island, 24 cards of each resource, 34 development cards |
| Setup | Random seating, two settlements and roads in forward/reverse order; starting resources from the second settlement |
| Production | Dice payouts, double city production, robber blocking, finite-bank shortage handling |
| Seven | Players with more than seven **resource cards** choose half, rounded down (9 → 4); development cards do not count; the robber waits for all required discards |
| Robber | Actor chooses a different hex and an adjacent opponent who has resources; one uniformly random resource card is transferred directly, never a development card |
| Construction | Roads, distance-rule settlements, city upgrades, connectivity, opponent road blocks, physical piece limits |
| Ports and bank | 4:1 bank, 3:1 generic port, 2:1 resource port; best owned ratio used automatically |
| Player trading | Offers, acceptance, rejection, cancellation and counteroffers involving the active primary player; no gifts or same-resource swaps |
| Development | Knight, Road Building, Year of Plenty (called Invention in the 2025 rulebook), Monopoly, hidden Victory Point cards |
| Card timing | One non-VP card per activation; no same-activation purchase/play; playable before rolling or during actions |
| Bonuses | Longest Road with forks/cycles/opponent interruptions and tie retention; Largest Army with strict takeover |
| Victory | Ten points on the player's own activation, including hidden/newly bought VP cards; automatic win and revealed final scores |
| After victory | The host can return everyone to the lobby for a rematch |

### Development-card inventory

Use **Public cards** beneath a player's nameplate to view their revealed development cards. Played Knights are shown face-up and still count toward Largest Army. Used Monopoly, Road Building, and Year of Plenty cards are labelled **discarded**: the gallery is a history of their public use, not an active hand. Victory-point cards appear only after the game ends. Unplayed cards are never exposed by this view.

Played-card counts are stored with the game and survive reconnects/restarts. Existing games use available structured activity from the current match to restore progress-card history; incomplete older history is labelled honestly rather than guessed. Knight counts remain exact. Starting a rematch clears that match's displayed plays.

| Card | 3-4 players | 5-6 players |
|---|---:|---:|
| Knight | 14 | 20 |
| Victory Point | 5 | 5 |
| Monopoly | 2 | 3 |
| Road Building | 2 | 3 |
| Year of Plenty / Invention | 2 | 3 |
| **Total** | **25** | **34** |

Player trading always involves the active primary player. Other players may propose trades to that player or respond/counteroffer, but may not trade independently with each other. The paired secondary player may trade with the bank/ports only.

### Trading timing and reliable offers

**No player or bank/port trading before the production roll.** First roll, collect resources, and fully resolve any seven (discards, robber, theft); then trade during the Action phase. An eligible older development card may be played before rolling, but that does not unlock trading. The interface explains the current restriction and the server rejects out-of-phase requests.

Trade responses are bound to the exact offer ID and terms, never whichever offer happens to be displayed later. Routine state/presence updates preserve the Accept button and draft inputs instead of replacing them mid-click. A replacement offer gets new response controls, so pressing an old button cannot accept new terms. Counteroffers default to the actual other party.

Accept explains missing resources, offline recovery, or an unconfirmed request. Cards are not reserved when offered; they move only when both inventories are checked and the exchange/receipt/history commit together. Spending the sender's offered resources, beginning a mandatory robber/free-road action, ending the turn, or removing a party closes invalid offers with a public activity entry. A shortage in the recipient's private hand is shown only to that recipient; it does not automatically disclose their holdings to the table.

Pending offers and submitted responses survive reconnect/restart. A slow or lost acknowledgement retries the same saved request without a second exchange. Delayed responses cannot accept changed terms, and delayed counteroffers cannot recreate closed trades. Editing an unsent draft is not a saved offer; closing the browser may discard that unsent draft.

The audited implementation covers the base game, the current paired-player extension, and the documented removal house rule—not unrelated expansions. Regression tests are a release gate, not a mathematical guarantee that no defect can ever occur. In particular, this implementation requires at least one legal available road before playing Road Building; the retrieved publisher FAQ did not conclusively address burning that card with zero legal roads.

### Returning cards on a seven

Affected players automatically see **Choose the cards to return**, with the exact calculation (for example, **9 in hand − 4 returned = 5 kept**). Use the resource steppers to choose what to give up. Confirmation stays disabled until the selected total is correct and the connection is ready.

**View the board first** minimizes the chooser without losing its selection; another player's discard does not erase your choices. Cards are returned only after confirmation and server persistence. Reopening a closed browser restores the outstanding obligation, not an automatic choice. The side panel shows which players are still required to discard.

Afterward, the roller moves the robber and chooses from the eligible opponent buttons. Those buttons show names and public resource-card counts, not the opponent's card faces. The server samples uniformly over individual cards: a victim holding nine wood and one ore gives a 90% wood / 10% ore partition, not a 50/50 choice between resource types. Empty hands cannot be robbed. The bank is unaffected by stealing.

### Paired-player turns

For five or six players, the primary player rolls and takes ordinary actions. The player **three seats clockwise** then takes an action-only activation: building, development cards, and bank/port trades, but **no second roll or player trading**. Afterward the primary marker advances one seat. Cards age between activations, and either active player can win.

This is **not** the older special-building-phase variant. Separate expansions such as Seafarers and Cities & Knights, bots, public matchmaking, spectators, chat, and turn timers are not part of this game.

### Rules references

Mechanics were checked against the publisher's current rules, not generated search summaries:

- [2025 base rulebook](https://www.catan.com/sites/default/files/2025-03/CN3081%20CATAN%E2%80%93The%20Game%20Rulebook%20secure%20%281%29.pdf)
- [2025 5-6-player rulebook](https://www.catan.com/sites/default/files/2025-03/CN3082%20CATAN%20%E2%80%93%205-6%20Rulebook%202025%20reduced.pdf)

The interface's **Field guide** summarizes the rules in original wording. Randomized balanced maps are used rather than reproducing the printed introductory map. Starting-player selection is randomized electronically instead of asking everyone to roll physical dice.

## Saved games and reconnection

Every accepted game action is saved **before** it is acknowledged or broadcast. A browser-side recovery record is written **before** sending a move. Unconfirmed moves keep the same request ID and sequence when retried, so a slow response, lost acknowledgement, reload, or server restart cannot turn one click into a second purchase, build, or dice roll. The server also rejects changed payloads that reuse an old request ID.

**Save & exit for now** keeps your seat, hand, and pieces. Closing the browser has the same non-destructive effect. The table waits when an offline player's input is needed; it does not automatically surrender that player's holdings.

The home screen's **Saved tables** list retains multiple rooms for this browser. Choose the desired room to resume another day. Reloading an active room URL automatically restores its seat. If a move was awaiting confirmation when the browser closed, reconnection resolves that original request before allowing another move.

Entering the same room code and player name in **Join table** also resumes a matching locally saved seat instead of attempting to create a duplicate. This uses the saved private credential, not the public name alone.

Use **Copy private resume key** to move to another browser/device, then paste it under **Resume on another device** on the home screen. Treat the key like a password: it grants control over your seat. Never share it with other players.

- The default database is `data/hearthlands.sqlite`, outside the public website. Set `DATABASE_URL` for PostgreSQL instead.
- Inactive rooms are archived after **90 days by default**, configurable with `ROOM_RETENTION_DAYS`; existing game data is not deleted.
- Keep the save directory persistent when deploying; ephemeral container disks are not sufficient.
- Disconnected players keep their seats; gameplay waits when their input is needed. The lobby host can remove absent players before starting, but cannot arbitrarily remove players mid-game.
- Guests are identified by possession of the resume key, not verified accounts.

Browser storage must remain available. If a recovery record cannot be written, the application does not send the move and explains why. Clearing browser data removes locally saved keys, and closing the last Incognito/private window may erase them. Copy the private resume key before doing either, or before changing browsers/devices. The game remains saved on the server, but possession of that key is required to reclaim a guest seat.

### Admin-controlled removal (house rule)

Each table has exactly one admin (`hostId` is the authoritative stored role). **Going offline never transfers that role.** The admin can explicitly transfer it to another active player.

Non-admins use **Request removal**. Holdings remain unchanged until the admin approves, and requests can be cancelled or declined. Only the admin can remove players. An admin leaving their own seat must explicitly select a successor; the handover and removal commit together. On confirmed removal:

- Held resources return to the bank.
- Unplayed development cards, including hidden victory cards, return to the shuffled deck.
- Roads, settlements, and cities belonging to that player are removed.
- Their army and longest-road contributions are removed; awards and scores are recalculated.
- Their pending trades and turn obligations are resolved so other players can continue.
- Their retired seat cannot be reclaimed or used to send further game actions.

Previously played development cards stay spent, and earlier trades, thefts, and production are not undone. The existing island, ports, and original supply size are retained; a six-player island does not shrink when someone leaves. Paired turns are used while at least five players remain, then play transitions to ordinary turns. A paired activation already in progress is completed safely.

If the departing player was taking a turn, unfinished personal robber/free-road choices are forfeited. Discards still owed by surviving players remain mandatory; after those are completed, the scheduled successor continues with their production or action phase.

This requested continuation rule permits two remaining players to continue an already-started game. The last remaining player wins, even below ten points. **New games still require at least three players.** Admin-controlled removal and continuation are house rules, not publisher rules.

## Database storage

Room state, durable request receipts/sequences, and newly recorded public activity are committed in the same database transaction. Notifications are published only after a successful commit. A failed database write must not produce a successful action or a false trade notification.

- **SQLite:** automatic local setup using the pinned Node LTS runtime.
- **PostgreSQL:** configure `DATABASE_URL` and an isolated `DATABASE_SCHEMA` (default `hearthlands_game`). Schema initialization is additive and refuses to take over unrelated tables.
- **Migration:** existing version-2 JSON saves are imported without deleting or overwriting the originals. An initialized database is not replaced by stale JSON files.
- **Privacy:** database snapshots contain private hands and resume credentials. Restrict filesystem/database access; do not expose the database directly to players.
- **Coordination:** one authoritative server process per database/schema. Database coordination and revision checks protect against conflicting writers.

### Local PostgreSQL

The optional local helper uses a real PostgreSQL 17 instance, isolated under `.local-postgres` and bound to loopback. It does not create a system user/service, and stopping it does not delete the data.

```powershell
fnm use
npm run db:local
# In another terminal, from this directory:
fnm use
npm run start:local-db
```

Generated development credentials are stored in the ignored `.local-postgres\connection.env` file. Do not commit or share it. Local database tests use the separate `hearthlands_test` database and isolated test schemas, not an Azure database.

### Existing Azure PostgreSQL

The supplied server is `aman.postgres.database.azure.com` (PostgreSQL 17). Its metadata indicates password authentication is enabled and Microsoft Entra authentication is disabled. No passwords, authentication settings, existing applications, databases, or resource contents are changed by this project.

To connect, configure a private `.env` file locally using `.env.example`. Set `DATABASE_URL` to a database you authorize, with a properly URL-encoded password, `DATABASE_SCHEMA=hearthlands_game`, and verified TLS. Prefer a least-privileged application account scoped to the dedicated schema. Do not paste passwords into chat or commit them.

Run `npm run db:check` first. That probe uses a read-only transaction and performs no schema initialization or data writes.

No cloud schema initialization is performed without valid connection credentials. Existing data is never dropped, truncated, or reset. Local PostgreSQL validation is separate from an actual Azure connection.

For PostgreSQL integration tests, set `TEST_DATABASE_URL` to the **isolated loopback test database**, then run the Node suite and `e2e/postgres.spec.js`. These tests refuse non-loopback targets; they must not be pointed at the supplied Azure server. The local helper's ignored connection file includes a separate test URL.

## Activity and notifications

Bank trades and accepted player trades report their actual public resource amounts to every connected player. Builds, dice, production, development actions, admin changes, and removals are recorded as structured public-safe events. Drawn development-card faces, stolen resource types, and chosen discard types remain private.

The sidebar shows recent activity; **Full history** loads earlier database records with pagination. Receipts prevent retries from creating duplicate events. Rejoining players get a catch-up indication rather than a flood of old toasts. Imported legacy log messages are preserved, but entries trimmed before this upgrade cannot be reconstructed.

## Internet hosting

This repository is ready to run as a **single Node.js process** behind an HTTPS reverse proxy supporting WebSockets. It is not automatically published to a public URL; hosting credentials, a domain, and any hosting charges remain under your control.

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP/WebSocket port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `data` beside the server | Persistent private save directory |
| `DATABASE_URL` | unset | PostgreSQL connection; unset selects local SQLite |
| `DATABASE_SCHEMA` | `hearthlands_game` | Isolated PostgreSQL application schema |
| `DATABASE_SSL` | verified TLS | Use `require` for Azure; explicit `disable` is for local development only |
| `ROOM_RETENTION_DAYS` | `90` | Inactive-room retention, from 1 to 3650 days |
| `ALLOWED_ORIGINS` | same-host only | Comma-separated exact trusted origins if the reverse proxy changes the upstream Host header |

Configure the proxy to preserve the original Host header, forward WebSocket upgrades, and serve HTTPS. Same-origin access works without CORS overrides. Do not add wildcard origins. Do not run multiple service instances against the same save directory: this implementation intentionally uses one authoritative process.

Docker files are included. Set a private `POSTGRES_PASSWORD` first:

```powershell
docker compose up --build
```

Compose uses a separate PostgreSQL service and persistent named volumes. It does not touch existing application containers or databases. Do not use destructive volume-removal commands. A health endpoint is available at `/health`. Configure TLS termination before internet exposure.

### Azure deployment

**Live game:** https://catan.trackgrowth.in

The [original Azure URL](https://hearthlands-online.yellowwater-07aa7c55.centralindia.azurecontainerapps.io) remains available and uses the same server and saved games.

The Central India deployment uses a fresh dedicated `hearthlands` database and a restricted `hearthlands_app` login on the existing PostgreSQL server. Existing local games were intentionally not migrated; the local database and other applications' data were left untouched. The application connection is stored as a Container Apps secret and in the ignored, access-restricted local `.env.azure` file. It does not use the shared administrator login at runtime.

Host the frontend and Socket.IO backend together in one **Azure Container App**, backed by a dedicated PostgreSQL database. Vercel Functions now support WebSockets, but connections have a maximum duration and future connections can reach another function instance. This game's single-coordinator design fits a continuously running container better; splitting the frontend adds another origin/deployment without improving the game server.

`infra/main.bicep` reuses these resources in subscription `e8920202-01dd-4705-a790-187313cdde20`:

| Resource | Use |
|---|---|
| `growth-tracker-rg/growth-tracker-env` | Existing Container Apps environment in Central India |
| `growth-tracker-rg/growthtrackeracr` | Existing registry; separate `hearthlands-online` image repository |
| `aman/aman` PostgreSQL server | Dedicated `hearthlands` database and restricted application login |
| Resource group `aman` | New `hearthlands-online` app and its image-pull identity |

The template creates only the game app, a managed identity, and an `AcrPull` assignment. It does not deploy or modify the PostgreSQL server, existing apps, environment, registry settings, or firewall. Image pulls use managed identity rather than shared registry passwords. HTTPS-only ingress supports WebSockets on port 3000. One 0.25-vCPU/0.5-GiB replica stays running; do not enable autoscaling.

**Cost:** the new running replica and its logs incur usage charges, even when nobody is playing. The existing registry, environment, and database are reused rather than creating duplicate services. Long-lived game connections can result in active rather than idle billing. This is not a free or highly available multi-instance deployment.

**Database prerequisite:** for a new environment, use an authorized setup account to create a dedicated game database and least-privileged application login. For this deployment, those already exist: reuse the protected application credential rather than recreating them. Keep connection strings outside Git and use verified TLS. Do not reuse an unrelated application's tables, reset the server password, change shared authentication, or deploy with a dummy connection string. A read-only connectivity probe must succeed before deployment. The container's temporary filesystem is not a substitute for PostgreSQL.

To build a release without installing Docker locally:

```powershell
az acr build --subscription e8920202-01dd-4705-a790-187313cdde20 `
  --resource-group growth-tracker-rg --registry growthtrackeracr `
  --image hearthlands-online:<unique-release-tag> --platform linux/amd64 .
```

The Docker build context is an allowlist: saved games, credentials, tests, local databases, and Git history are excluded. The image includes a build-time server-module load check. Deploy the resulting image by immutable digest.

Run provider-level what-if before an **incremental** deployment:

```powershell
az deployment group what-if --subscription e8920202-01dd-4705-a790-187313cdde20 `
  --resource-group aman --template-file infra\main.bicep `
  --parameters image=<registry-image-at-sha256-digest> revisionSuffix=<unique-release> `
  --validation-level Provider

az deployment group create --subscription e8920202-01dd-4705-a790-187313cdde20 `
  --resource-group aman --mode Incremental --template-file infra\main.bicep `
  --parameters image=<registry-image-at-sha256-digest> revisionSuffix=<unique-release>
```

Azure CLI prompts for the omitted secure `databaseUrl` parameter; do not place a real password in a command, committed parameter file, or deployment output. The template's `gameUrl` output is the generated HTTPS address; `customGameUrl` is the configured custom address. A successful what-if with a placeholder secret is **not** a working database connection or a completed deployment.

#### Custom domain and managed HTTPS

`catan.trackgrowth.in` is bound to the same Container App, with a free Azure-managed certificate. The DNS records in GoDaddy must remain in place for ownership validation and automatic certificate renewal:

| Type | Name | Value |
|---|---|---|
| CNAME | `catan` | `hearthlands-online.yellowwater-07aa7c55.centralindia.azurecontainerapps.io` |
| TXT | `asuid.catan` | `21C93BC9052F330B8A7EC3CFCAC1874090774DC2BA7B8B6ECB4C4F1DDD994CF9` |

The CNAME points directly to Azure; do not replace it with a forwarding or proxy service. If restrictive CAA records are introduced, allow `digicert.com` for the managed certificate. The root website, mail records and other subdomains are independent and were not changed.

The live public binding is recorded in `infra/custom-domains.json` and loaded by `infra/main.bicep`, so a full deployment does not silently remove HTTPS from the custom hostname. The certificate is an existing environment resource, not recreated by the template. For a different environment, explicitly override `customDomainBindings=[]` initially, validate its DNS and certificate, then supply that environment's bindings. Routine releases should still use the image-only update below.

Binding commands use `--location centralindia` explicitly, rather than an unrelated Azure CLI default, and reference the environment by full resource ID because it resides in `growth-tracker-rg`, not the app's resource group.

**Returning to an existing game from the new URL:** browser seat storage is separate for each origin. On the original Azure URL, open your saved table, choose **Room & session → Copy private resume key**, then on `catan.trackgrowth.in` use **Resume on another device**. This restores the same server-side seat, not a new game. Keep that key private. Subsequent visits can use Saved tables on the new address. New invite links automatically use the hostname where the game is open.

**Existing local games:** deployment does not automatically copy them. Preserve the local PostgreSQL cluster and private resume keys. Before a cutover, stop new local gameplay, take a consistent backup of all room snapshots **and full event history**, and import into an empty, game-owned cloud destination. Preserve request receipts, sequences, keys, and original backups; never overwrite existing cloud rows. Changing the browser origin does not transfer localStorage: players need their private resume keys at the new URL. Do not run two independently writable copies of the same migrated game.

**Updates and rollback:** revisions use multiple-revision mode only to permit explicit stop-before-start releases. Keep exactly **one active revision**; do not use blue/green overlap or traffic splitting against this database. Before an upgrade, record the healthy revision/image and back up the game, then deactivate that revision (this stops compute, not data), deploy the next one, and confirm `/health`, WebSocket connections, and resumed game state. If it fails, deactivate the failed revision before reactivating the previous compatible revision. Do not delete revisions, databases, schemas, registry images, or storage as a rollback mechanism. Expect a short reconnect window during replacement.

For image-only releases, preserve the existing identity, access assignments, secrets and ingress settings with `az containerapp update`, rather than reprovisioning all resources:

```powershell
az containerapp revision deactivate --subscription e8920202-01dd-4705-a790-187313cdde20 `
  --resource-group aman --name hearthlands-online --revision <current-revision>
# Confirm the old revision is inactive, runningState=Stopped, replicas=0.
# Retained NotRunning replica records are not live processes.
az containerapp update --subscription e8920202-01dd-4705-a790-187313cdde20 `
  --resource-group aman --name hearthlands-online `
  --image <registry-image-at-sha256-digest> --revision-suffix <unique-release> `
  --min-replicas 1 --max-replicas 1
```

Avoid **`az containerapp revision restart`** for this single-coordinator application: it can roll a replacement replica while the old process still owns the database lease. The old process can keep serving healthy responses while the replacement crash-loops, so a successful HTTP request alone does not prove replacement occurred. Use explicit deactivate/activate for a same-image restart, or deactivate/update for a release, and verify one healthy active revision and a newly started replica.

## Automated checks

```powershell
npm test
npx playwright install chromium
npm run test:e2e
```

The Node suite covers rules and real Socket.IO clients, including saved positions, seat transfer, rejected input, durable request receipts, private state, preview/shuffle rules, ephemeral presence, and resignation across the different turn phases. Browser tests use isolated player contexts and temporary save directories.

| Test surface | Scenarios |
|---|---|
| Components | Labelled player statistics, resource radios, keyboard/search location picker, quantity limits, pending/settled dice and reduced motion |
| Gameplay | Three-, four-, five-, and six-player setup/turns; complete three- and six-browser matches through victory/rematch |
| Network | Slow response frames, repeated attempts with one ID, lost requests/acknowledgements, and browser closure before/after commit |
| Saved games | Closed browsers retain holdings, later resumption after restart, multiple saved tables, private-key recovery |
| Session safety | Newest-tab ownership, stale-tab denial, browser-storage failure, terminal rejection followed by a valid move |
| Joining | Lost create/join confirmations recover the same seat, not duplicate players |
| Removal/admin | Requests and approval, explicit succession, stable offline admin, inventory return, continued play, and lost-confirmation recovery |
| Database/activity | Atomic snapshots/events/receipts, safe legacy migration, foreign-data protection, history pagination, and both database adapters |
| Existing features | Counteroffers, all development cards, shared pointers/touch pings, zoom, shuffle/start, sound and fullscreen |

Component-only stories use explicit render fixtures. Integration tests drive real controls through Socket.IO; failure tests gate WebSocket frames rather than adding public testing endpoints. There is no production endpoint for injecting dice rolls, resources, or game positions.

`e2e/deployment.spec.js` is opt-in: set `HEARTHLANDS_DEPLOYMENT_URL` to an HTTPS game URL to exercise real cloud play, direct placement/undo, WebSocket heartbeats, offline recovery, and the saved-table Resume control after reopening the browser. It creates a new test room and deliberately does not delete it. After an explicit stop/start or later deployment, set `HEARTHLANDS_RECOVERY_FILE` to the generated private `cloud-recovery.json` artifact and run the cloud-process-restart case to verify all three saved players. Recovery artifacts contain only newly generated test-seat credentials, remain under ignored `test-results`, and must not be published.

Set `HEARTHLANDS_CUSTOM_DOMAIN_URL=https://catan.trackgrowth.in` to opt into `e2e/domain.spec.js`, which verifies trusted HTTPS, redirects and reclaiming a newly created test seat from the original origin using its private key. It never touches or deletes other players' seats.

## Architecture

- `game.js`: serializable, authoritative rules and per-player legal-action views
- `server.js`: Socket.IO transport, single-admin authorization, serialized transactions, activity history, origin controls and request limits
- `storage`: transactional SQLite/PostgreSQL adapters and safe schema initialization
- `public/client.js`: responsive game interface, turn guidance, cards, and controls
- `public/tabletop.js`: original reusable vector terrain, pieces, and resource artwork
- `public/presence.js`: shared cursor/ping rendering and coordinate transforms
- `public/connection.js`: private saved-seat records, durable browser outbox, and retry/reconnect lifecycle
- `public/components.js` / `components.css`: accessible game selectors, counters, nameplates, and 3D dice
- `public/cards.js`, `finish.css`, `activity.js`: physical cards, self-hosted typography, ripple effects and committed-event notifications
- `test`: Node rules/network regression tests
- `e2e`: browser tests and a deterministic test-only player strategy

All random outcomes are chosen on the server. Clients submit intentions, not resource counts, winners, dice results, or board mutations. Development deck order, other players' card faces, and resume keys are never included in state broadcasts.

### Libraries

Express serves the application, Socket.IO synchronizes players, Node SQLite and `pg` provide database persistence, Panzoom provides GPU-accelerated map interaction, and Playwright drives real-browser tests. Cinzel and Source Sans 3 are self-hosted under their OFL licences. No runtime font/CDN dependency is required. Git remains local; no remote push is part of setup.
