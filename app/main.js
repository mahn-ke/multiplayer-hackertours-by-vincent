import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { openapi } from './openapi.js';

// The announce server of the Hackertours race (docs/multiplayer.md "Directory" in hackertours-apps): consoles of one event announce the
// addresses their race socket can be reached at, and learn the others', so that a lobby's HELLO reaches them where broadcast does not
// (an event's VLANs). It never relays a packet. The list lives in memory only, forgets a device after `ttlMs`, and no address is logged.

const roomPattern = /^[a-z0-9_-]{1,40}\/[a-z0-9_-]{1,40}$/;
const idPattern = /^[0-9a-f]{8}$/;
const states = new Set(['idle', 'lobby', 'racing']);
const fields = new Set(['room', 'id', 'port', 'addresses', 'state']);

export function createApp({
    issuer = process.env.OAUTH_URL || 'https://sso.by.vincent.mahn.ke/realms/sso.by.vincent.mahn.ke',
    clients = {
        '3ds': process.env.OAUTH_CONSOLE_3DS_CLIENT_ID,
        xbox: process.env.OAUTH_CONSOLE_XBOX_CLIENT_ID,
        switch: process.env.OAUTH_CONSOLE_SWITCH_CLIENT_ID,
        gba: process.env.OAUTH_CONSOLE_GBA_CLIENT_ID,
    },
    trustProxy = process.env.TRUST_PROXY === '1',
    jwks,
    now = () => Date.now(),
    ttlMs = 60000,
    rateLimit = 1200,
    maxPeers = 64,
} = {}) {
    const platforms = new Map();
    for (const [platform, clientId] of Object.entries(clients)) {
        if (!clientId) continue;
        if (platforms.has(clientId)) throw new Error(`The client id of ${platform} is the same as another platform's`);
        platforms.set(clientId, platform);
    }
    if (!platforms.size) throw new Error('At least one OAUTH_CONSOLE_*_CLIENT_ID is required');
    const keys = jwks || createRemoteJWKSet(new URL(`${issuer.replace(/\/$/, '')}/protocol/openid-connect/certs`));
    const rooms = new Map(); // room -> Map(id -> { platform, addresses, state, seenAt })
    const buckets = new Map();

    const send = (res, status, value, headers = {}) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
        res.end(JSON.stringify(value));
    };
    const observed = req => {
        let address = req.socket.remoteAddress || '';
        if (trustProxy) {
            const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
            if (forwarded) address = forwarded;
        }
        return address.startsWith('::ffff:') ? address.slice(7) : address;
    };
    const expire = room => {
        const peers = rooms.get(room);
        if (!peers) return null;
        for (const [id, peer] of peers) if (now() - peer.seenAt >= ttlMs) peers.delete(id);
        if (!peers.size) rooms.delete(room);
        return rooms.get(room) || null;
    };
    const list = (room, self) => {
        const peers = expire(room);
        if (!peers) return [];
        return [...peers].filter(([id]) => id !== self)
            .map(([id, peer]) => ({ id, platform: peer.platform, addresses: peer.addresses, state: peer.state }));
    };

    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url, 'http://localhost');
            if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { status: 'ok' });
            if (req.method === 'GET' && url.pathname === '/openapi.json') return send(res, 200, openapi);
            if (url.pathname !== '/api/peers' || !['GET', 'POST'].includes(req.method)) return send(res, 404, { error: 'Not found' });
            const bearer = /^Bearer (\S+)$/i.exec(req.headers.authorization || '');
            if (!bearer) return send(res, 401, { error: 'Bearer token required' }, { 'WWW-Authenticate': 'Bearer' });
            let payload;
            try {
                ({ payload } = await jwtVerify(bearer[1], keys, {
                    issuer, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'azp'], currentDate: new Date(now()),
                }));
            } catch {
                return send(res, 401, { error: 'Invalid or expired token' }, { 'WWW-Authenticate': 'Bearer' });
            }
            const platform = platforms.get(payload.azp);
            if (!platform) return send(res, 403, { error: 'Client is not allowed' });
            const minute = Math.floor(now() / 60000);
            const bucket = buckets.get(payload.azp);
            const count = bucket?.minute === minute ? bucket.count + 1 : 1;
            buckets.set(payload.azp, { minute, count });
            if (count > rateLimit) return send(res, 429, { error: 'Rate limit exceeded' }, { 'Retry-After': String(60 - Math.floor(now() / 1000) % 60) });

            if (req.method === 'GET') {
                const room = url.searchParams.get('room') || '';
                if (!roomPattern.test(room)) return send(res, 400, { error: 'Invalid room' });
                return send(res, 200, { you: observed(req), peers: list(room, url.searchParams.get('id') || '') });
            }

            if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] || '')) return send(res, 400, { error: 'Content-Type must be application/json' });
            let body;
            try {
                const chunks = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 2048) {
                        send(res, 400, { error: 'Body exceeds 2048 bytes' });
                        return;
                    }
                    chunks.push(chunk);
                }
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch { return send(res, 400, { error: 'Invalid JSON' }); }
            if (!body || Array.isArray(body) || typeof body !== 'object' || !Object.keys(body).every(key => fields.has(key)) ||
                typeof body.room !== 'string' || !roomPattern.test(body.room) ||
                typeof body.id !== 'string' || !idPattern.test(body.id) ||
                !Number.isInteger(body.port) || body.port < 1 || body.port > 65535 ||
                !Array.isArray(body.addresses) || body.addresses.length > 4 || !body.addresses.every(a => typeof a === 'string' && isIPv4(a)) ||
                typeof body.state !== 'string' || !states.has(body.state)) {
                return send(res, 400, { error: 'Invalid announcement' });
            }
            const you = observed(req);
            // The address the server sees the device at comes first: on an event network it is the one the others can reach.
            const addresses = [...new Set([...(isIPv4(you) ? [you] : []), ...body.addresses])].map(ip => `${ip}:${body.port}`);
            let peers = expire(body.room);
            if (!peers) {
                peers = new Map();
                rooms.set(body.room, peers);
            }
            if (!peers.has(body.id) && peers.size >= maxPeers) return send(res, 429, { error: 'Room is full' });
            peers.set(body.id, { platform, addresses, state: body.state, seenAt: now() });
            return send(res, 200, { you, peers: list(body.room, body.id) });
        } catch (error) {
            console.error(error.message);
            if (!res.headersSent) send(res, 500, { error: 'Internal server error' });
            else res.destroy();
        }
    });
    server.requestTimeout = 10000;
    server.headersTimeout = 10000;
    return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const server = createApp();
    server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Multiplayer announce service listening'));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}
