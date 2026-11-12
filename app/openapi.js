const announcement = {
    type: 'object', additionalProperties: false, required: ['room', 'id', 'port', 'addresses', 'state'],
    properties: {
        room: { type: 'string', pattern: '^[a-z0-9_-]{1,40}/[a-z0-9_-]{1,40}$', description: 'The shop\'s organizer and event slug.' },
        id: { type: 'string', pattern: '^[0-9a-f]{8}$', description: 'The race session\'s sender id (u32) in lowercase hex.' },
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'The UDP port the race socket is bound to (47610-47613).' },
        addresses: { type: 'array', maxItems: 4, items: { type: 'string', format: 'ipv4' }, description: 'The device\'s own IPv4 addresses.' },
        state: { type: 'string', enum: ['idle', 'lobby', 'racing'] },
    },
};
const peer = {
    type: 'object', additionalProperties: false, required: ['id', 'platform', 'addresses', 'state'],
    properties: {
        id: announcement.properties.id,
        platform: { type: 'string', enum: ['3ds', 'xbox', 'switch', 'gba'], description: 'From the announcing token\'s azp claim.' },
        addresses: { type: 'array', items: { type: 'string', description: 'IPv4:port, the address the server saw it from first.' } },
        state: announcement.properties.state,
    },
};
const peers = {
    type: 'object', additionalProperties: false, required: ['you', 'peers'],
    properties: { you: { type: 'string', description: 'The address the server sees the caller at.' }, peers: { type: 'array', items: peer } },
};
const json = schema => ({ 'application/json': { schema } });
const response = (description, schema) => ({ description, content: json(schema) });
const error = { type: 'object', required: ['error'], properties: { error: { type: 'string' } } };
const security = [{ bearer: [] }];

export const openapi = {
    openapi: '3.0.3',
    info: {
        title: 'Hackertours Racing Announce API', version: '1.0.0',
        description: 'Where the race consoles of one event can be reached (docs/multiplayer.md "Directory"). Memory only; a device is forgotten after 60 s.',
    },
    servers: [{ url: '/' }],
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    paths: {
        '/healthz': { get: { responses: { 200: response('Alive', { type: 'object', properties: { status: { type: 'string' } } }) } } },
        '/api/peers': {
            get: {
                security,
                parameters: [
                    { name: 'room', in: 'query', required: true, schema: announcement.properties.room },
                    { name: 'id', in: 'query', required: false, schema: announcement.properties.id, description: 'Left out of the list.' },
                ],
                responses: { 200: response('The room\'s devices seen in the last 60 s', peers), 400: response('Bad request', error), 401: response('No valid token', error), 403: response('Client not allowed', error), 429: response('Rate limit', error) },
            },
            post: {
                security,
                requestBody: { required: true, content: json(announcement) },
                responses: { 200: response('Announced; the room\'s other devices', peers), 400: response('Bad request', error), 401: response('No valid token', error), 403: response('Client not allowed', error), 429: response('Rate limit or room full', error) },
            },
        },
    },
};
