import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createApp } from './main.js';

const issuer = 'https://keycloak.example/realms/test';
const nowSeconds = 1792956000;
const { privateKey, publicKey } = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(publicKey), kid: 'local', alg: 'RS256', use: 'sig' };
const jwks = createLocalJWKSet({ keys: [jwk] });
const token = async (azp = 'console-3ds', changes = {}) => new SignJWT({ azp, ...changes })
    .setProtectedHeader({ alg: 'RS256', kid: 'local' }).setIssuer(issuer)
    .setSubject('service-account-console').setIssuedAt(nowSeconds).setExpirationTime(nowSeconds + 3600)
    .sign(privateKey);
const clients = { '3ds': 'console-3ds', xbox: 'console-xbox', switch: 'console-switch', gba: 'console-gba' };
const room = 'hackertours/40c3';

async function fixture(t, options = {}) {
    let clock = nowSeconds * 1000;
    const server = createApp({ issuer, clients, jwks, now: () => clock, ...options });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.listening ? new Promise(done => { server.close(done); server.closeAllConnections(); }) : undefined);
    const base = `http://127.0.0.1:${server.address().port}`;
    const announce = async (body, azp = 'console-3ds', headers = {}) => fetch(`${base}/api/peers`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(azp)}`, ...headers }, body: JSON.stringify(body),
    });
    return { base, announce, advance: ms => { clock += ms; } };
}

const device = (id, state = 'idle', addresses = ['10.0.0.5']) => ({ room, id, port: 47610, addresses, state });

test('devices of a room see each other, by the token\'s platform, with the address the server saw first', async t => {
    const { base, announce } = await fixture(t);
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { status: 'ok' });
    assert.equal((await (await fetch(`${base}/openapi.json`)).json()).openapi, '3.0.3');
    const first = await announce(device('11223344', 'lobby'), 'console-switch');
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { you: '127.0.0.1', peers: [] });
    const second = await (await announce(device('55667788', 'idle', ['192.168.1.7']), 'console-gba')).json();
    assert.deepEqual(second.peers, [{ id: '11223344', platform: 'switch', addresses: ['127.0.0.1:47610', '10.0.0.5:47610'], state: 'lobby' }]);
    const listed = await fetch(`${base}/api/peers?room=${encodeURIComponent(room)}&id=11223344`, { headers: { Authorization: `Bearer ${await token()}` } });
    assert.deepEqual((await listed.json()).peers.map(p => [p.id, p.platform]), [['55667788', 'gba']]);
    // another event's room is another list
    const elsewhere = await (await announce({ ...device('99999999'), room: 'hackertours/39c3' })).json();
    assert.deepEqual(elsewhere.peers, []);
});

test('a device that stops announcing is forgotten after a minute', async t => {
    const { announce, advance } = await fixture(t);
    await announce(device('11223344'));
    advance(59000);
    assert.equal((await (await announce(device('55667788'))).json()).peers.length, 1);
    advance(1000);
    assert.equal((await (await announce(device('55667788'))).json()).peers.length, 0);
});

test('only known clients with valid tokens and valid announcements', async t => {
    const { base, announce } = await fixture(t);
    assert.equal((await fetch(`${base}/api/peers?room=${room}`)).status, 401);
    assert.equal((await announce(device('11223344'), 'someone-else')).status, 403);
    const bad = [
        { ...device('11223344'), room: 'no slash' }, { ...device('1122334') }, { ...device('11223344'), port: 0 },
        { ...device('11223344'), addresses: ['::1'] }, { ...device('11223344'), addresses: ['1.2.3.4', '1.2.3.5', '1.2.3.6', '1.2.3.7', '1.2.3.8'] },
        { ...device('11223344'), state: 'flying' }, { ...device('11223344'), platform: 'n64' },
    ];
    for (const body of bad) assert.equal((await announce(body, 'console-xbox')).status, 400, JSON.stringify(body));
    const limited = await fixture(t, { rateLimit: 2 });
    assert.equal((await limited.announce(device('11223344'), 'console-xbox')).status, 200);
    assert.equal((await limited.announce(device('11223344'), 'console-xbox')).status, 200);
    assert.equal((await limited.announce(device('11223344'), 'console-xbox')).status, 429);
    assert.equal((await limited.announce(device('55667788'), 'console-gba')).status, 200);  // per client
});

test('the proxy\'s address is used only when trusted, and a room has room for 64', async t => {
    const trusting = await fixture(t, { trustProxy: true, maxPeers: 2 });
    const seen = await (await trusting.announce(device('11223344'), 'console-3ds', { 'X-Forwarded-For': '151.217.1.2, 10.0.0.1' })).json();
    assert.equal(seen.you, '151.217.1.2');
    assert.equal((await trusting.announce(device('55667788'))).status, 200);
    assert.equal((await trusting.announce(device('99999999'))).status, 429);
    const plain = await fixture(t);
    assert.equal((await (await plain.announce(device('11223344'), 'console-3ds', { 'X-Forwarded-For': '151.217.1.2' })).json()).you, '127.0.0.1');
});

test('the configuration needs distinct client ids', () => {
    assert.throws(() => createApp({ issuer, jwks, clients: {} }));
    assert.throws(() => createApp({ issuer, jwks, clients: { '3ds': 'same', xbox: 'same' } }));
});
