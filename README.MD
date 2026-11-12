# multiplayer.hackertours.by.vincent.mahn.ke

Hosts the container serving [multiplayer.hackertours.by.vincent.mahn.ke](https://multiplayer.hackertours.by.vincent.mahn.ke).

The announce server of the Hackertours race (the "Directory" of `docs/multiplayer.md` in hackertours-apps). The race consoles (Nintendo
3DS, Xbox 360, Nintendo Switch, and the GBA through its link server) find each other by UDP broadcast on a LAN. On an event network split
into VLANs broadcast does not reach the others, although they can reach each other: each device announces the addresses its race socket
can be reached at, learns the others', and sends its lobby's HELLO there too. The server never relays a packet and nothing scans a network.

Node.js 26, no database: the list lives in memory and forgets a device after 60 seconds; no address is ever logged. Keycloak
client-credentials authentication with the consoles' service accounts of the shared high scores (and one for the GBA's link server); the
platform of an announcement is the token's `azp`. The machine-readable API is at `/openapi.json`.

## API

| Method | Path | Authentication | Result |
| --- | --- | --- | --- |
| GET | `/healthz` | None | `{"status":"ok"}` |
| POST | `/api/peers` | Bearer access token | announces the caller; the room's other devices |
| GET | `/api/peers?room=org/event[&id=ID]` | Bearer access token | the room's devices (without `id`) |

POST takes `Content-Type: application/json`, at most 2048 bytes, with these fields only:

```json
{"room":"hackertours/40c3","id":"11223344","port":47611,"addresses":["10.0.0.5"],"state":"lobby"}
```

| Field | Validation |
| --- | --- |
| room | the shop's organizer and event slug, `^[a-z0-9_-]{1,40}/[a-z0-9_-]{1,40}$` |
| id | the race session's sender id, 8 lowercase hex digits |
| port | the UDP port of the race socket, 1–65535 (47610–47613 in practice) |
| addresses | the device's own IPv4 addresses, at most 4 |
| state | `idle`, `lobby` (MAP SELECT open) or `racing` |

Both answers are `{"you":"151.217.1.2","peers":[{"id":"55667788","platform":"switch","addresses":["151.217.3.4:47610","10.0.0.9:47610"],"state":"lobby"}]}`:
`you` is the address the server sees the caller at, and each peer's addresses start with the one the server saw it from. A device
announces at start-up, every 20 seconds and when its state changes.

Errors are JSON `{"error":"description"}`: 400 for invalid input, 401 for absent, invalid or expired tokens, 403 for a token of another
client, 404 for unknown routes, 429 for the per-client quota (1200 requests per minute) or a full room (64 devices).

## Configuration

| Variable | Meaning |
| --- | --- |
| `OAUTH_URL` | the Keycloak realm (default `https://sso.by.vincent.mahn.ke/realms/sso.by.vincent.mahn.ke`) |
| `OAUTH_CONSOLE_3DS_CLIENT_ID`, `..._XBOX_...`, `..._SWITCH_...`, `..._GBA_...` | the clients allowed to announce (at least one, all distinct) |
| `TRUST_PROXY` | `1`: the caller's address is the first of `X-Forwarded-For` (behind the reverse proxy; the compose file sets it) |

## Development

```sh
cd app && npm ci && npm test
```
