const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const axios = require('axios');

const {
    app,
    DEFAULT_PHONE_NUMBER_ID,
    getEnvVar,
    resolvePhoneNumberId,
    getAiClient,
    processWebhookEvent,
    gerarRespostaAtendimento,
    enviarMensagemWhatsApp,
} = require('../index');

function clearEnvVariants(prefixes) {
    for (const key of Object.keys(process.env)) {
        const normalized = key.trim().replace(/[\s-]+/g, '_').replace(/_+/g, '_').toUpperCase();
        if (prefixes.includes(normalized)) {
            delete process.env[key];
        }
    }
}

function httpRequest(port, method, path, body = null) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method,
                headers: payload
                    ? {
                          'Content-Type': 'application/json',
                          'Content-Length': Buffer.byteLength(payload),
                      }
                    : {},
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve({ statusCode: res.statusCode, body: data });
                });
            }
        );
        req.on('error', reject);
        if (payload) {
            req.write(payload);
        }
        req.end();
    });
}

describe('Leitura de variáveis de ambiente', () => {
    it('resolve WHATSAPP_TOKEN com underscore e variações com espaço/capitalização', () => {
        assert.equal(getEnvVar('WHATSAPP_TOKEN', { WHATSAPP_TOKEN: 'token-underscore' }), 'token-underscore');
        assert.equal(getEnvVar('WHATSAPP_TOKEN', { 'WHATSAPP TOKEN': 'token-space-upper' }), 'token-space-upper');
        assert.equal(getEnvVar('WHATSAPP_TOKEN', { 'WhatsApp token': '  token-mixed-case  ' }), 'token-mixed-case');
        assert.equal(getEnvVar('WHATSAPP_TOKEN', { 'whatsapp  token': 'token-multi-space' }), 'token-multi-space');
    });

    it('ignora valor vazio em WHATSAPP_TOKEN e usa variação preenchida ou retorna undefined se ausente', () => {
        assert.equal(
            getEnvVar('WHATSAPP_TOKEN', { WHATSAPP_TOKEN: '   ', 'WHATSAPP TOKEN': 'token-valido' }),
            'token-valido'
        );
        assert.equal(getEnvVar('WHATSAPP_TOKEN', { WHATSAPP_TOKEN: '' }), undefined);
        assert.equal(getEnvVar('WHATSAPP_TOKEN', {}), undefined);
    });

    it('resolve variações com espaço para PHONE_NUMBER_ID, VERIFY_TOKEN e GEMINI_API_KEY', () => {
        const env = {
            'PHONE NUMBER ID': '1532130713305838',
            'Verify Token': 'babyfilms2026',
            'Gemini API Key': 'gem-key-123',
        };
        assert.equal(getEnvVar('PHONE_NUMBER_ID', env), '1532130713305838');
        assert.equal(getEnvVar('VERIFY_TOKEN', env), 'babyfilms2026');
        assert.equal(getEnvVar('GEMINI_API_KEY', env), 'gem-key-123');
    });
});

describe('Resolução de PHONE_NUMBER_ID', () => {
    it('extrai dinamicamente de value.metadata.phone_number_id quando presente no webhook', () => {
        const value = { metadata: { phone_number_id: '999888777666555' } };
        const env = { PHONE_NUMBER_ID: '111222333444555' };
        assert.equal(resolvePhoneNumberId(value, env), '999888777666555');
    });

    it('usa variável de ambiente quando metadata.phone_number_id está ausente ou vazio', () => {
        assert.equal(
            resolvePhoneNumberId({ metadata: { phone_number_id: '  ' } }, { 'PHONE NUMBER ID': '222333444555666' }),
            '222333444555666'
        );
    });

    it('faz fallback para 1532130713305838 quando webhook e env não informam phone_number_id', () => {
        assert.equal(DEFAULT_PHONE_NUMBER_ID, '1532130713305838');
        assert.equal(resolvePhoneNumberId(null, {}), '1532130713305838');
        assert.equal(resolvePhoneNumberId({ metadata: {} }, { PHONE_NUMBER_ID: '' }), '1532130713305838');
    });
});

describe('Simulação de webhook e envio para WhatsApp Cloud API', () => {
    let envSnapshot;

    beforeEach(() => {
        envSnapshot = { ...process.env };
        clearEnvVariants(['WHATSAPP_TOKEN', 'PHONE_NUMBER_ID', 'VERIFY_TOKEN', 'GEMINI_API_KEY']);
    });

    afterEach(() => {
        mock.restoreAll();
        for (const key of Object.keys(process.env)) {
            if (!(key in envSnapshot)) {
                delete process.env[key];
            }
        }
        Object.assign(process.env, envSnapshot);
    });

    it('processa mensagem "Oi" de 5555996208688 usando "WHATSAPP TOKEN" e fallback 1532130713305838', async () => {
        process.env['WHATSAPP TOKEN'] = 'EAA-token-com-espaco';

        const axiosCalls = [];
        mock.method(axios, 'post', async (url, payload, config) => {
            axiosCalls.push({ url, payload, config });
            return { data: { messages: [{ id: 'wamid.test-123' }] } };
        });

        const webhookPayload = {
            object: 'whatsapp_business_account',
            entry: [
                {
                    id: '1888567902559306',
                    changes: [
                        {
                            field: 'messages',
                            value: {
                                messaging_product: 'whatsapp',
                                messages: [
                                    {
                                        from: '5555996208688',
                                        id: 'wamid.incoming-1',
                                        timestamp: '1764164200',
                                        text: { body: 'Oi' },
                                        type: 'text',
                                    },
                                ],
                            },
                        },
                    ],
                },
            ],
        };

        const result = await processWebhookEvent(webhookPayload);

        assert.equal(result.processed, true);
        assert.equal(result.phoneId, '1532130713305838');
        assert.equal(result.sendResult.sent, true);
        assert.equal(result.sendResult.messageId, 'wamid.test-123');

        assert.equal(axiosCalls.length, 1);
        assert.equal(axiosCalls[0].url, 'https://graph.facebook.com/v21.0/1532130713305838/messages');
        assert.equal(axiosCalls[0].config.headers.Authorization, 'Bearer EAA-token-com-espaco');
        assert.equal(axiosCalls[0].payload.messaging_product, 'whatsapp');
        assert.equal(axiosCalls[0].payload.to, '5555996208688');
        assert.equal(axiosCalls[0].payload.type, 'text');
        assert.match(axiosCalls[0].payload.text.body, /Baby Films/);
        assert.match(axiosCalls[0].payload.text.body, /https:\/\/youtu\.be\/HLIeDSifwVA/);
    });

    it('extrai phone_number_id dinâmico do payload e aceita "WhatsApp token" via HTTP POST /webhook', async () => {
        process.env['WhatsApp token'] = 'EAA-token-mixed';

        let resolvePostCalled;
        const postCalled = new Promise((resolve) => {
            resolvePostCalled = resolve;
        });

        const axiosCalls = [];
        mock.method(axios, 'post', async (url, payload, config) => {
            axiosCalls.push({ url, payload, config });
            resolvePostCalled();
            return { data: { messages: [{ id: 'wamid.http-456' }] } };
        });

        const server = app.listen(0);
        try {
            const { port } = server.address();
            const res = await httpRequest(port, 'POST', '/webhook', {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                value: {
                                    messaging_product: 'whatsapp',
                                    metadata: {
                                        phone_number_id: '987654321098765',
                                    },
                                    messages: [
                                        {
                                            from: '5555996208688',
                                            type: 'text',
                                            text: { body: 'Oi' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            });

            assert.equal(res.statusCode, 200);
            assert.equal(res.body, 'EVENT_RECEIVED');

            await postCalled;
            assert.equal(axiosCalls.length, 1);
            assert.equal(axiosCalls[0].url, 'https://graph.facebook.com/v21.0/987654321098765/messages');
            assert.equal(axiosCalls[0].config.headers.Authorization, 'Bearer EAA-token-mixed');
            assert.equal(axiosCalls[0].payload.to, '5555996208688');
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('processa webhook também quando WHATSAPP_TOKEN padrão com underscore está configurado', async () => {
        process.env.WHATSAPP_TOKEN = 'EAA-token-underscore';
        const axiosCalls = [];
        mock.method(axios, 'post', async (url, payload, config) => {
            axiosCalls.push({ url, payload, config });
            return { data: { messages: [{ id: 'wamid.underscore-789' }] } };
        });

        const result = await processWebhookEvent({
            object: 'whatsapp_business_account',
            entry: [
                {
                    changes: [
                        {
                            value: {
                                metadata: { phone_number_id: '1532130713305838' },
                                messages: [{ from: '5555996208688', type: 'text', text: { body: 'Oi' } }],
                            },
                        },
                    ],
                },
            ],
        });

        assert.equal(result.processed, true);
        assert.equal(result.sendResult.sent, true);
        assert.equal(axiosCalls.length, 1);
        assert.equal(axiosCalls[0].url, 'https://graph.facebook.com/v21.0/1532130713305838/messages');
        assert.equal(axiosCalls[0].config.headers.Authorization, 'Bearer EAA-token-underscore');
    });

    it('valida GET /webhook com verify_token e rejeita token inválido', async () => {
        process.env['VERIFY TOKEN'] = 'custom-verify-2026';
        const server = app.listen(0);
        try {
            const { port } = server.address();
            const okCustom = await httpRequest(
                port,
                'GET',
                '/webhook?hub.mode=subscribe&hub.verify_token=custom-verify-2026&hub.challenge=CHAL1'
            );
            assert.equal(okCustom.statusCode, 200);
            assert.equal(okCustom.body, 'CHAL1');

            const okFallback = await httpRequest(
                port,
                'GET',
                '/webhook?hub.mode=subscribe&hub.verify_token=babyfilms2026&hub.challenge=CHAL2'
            );
            assert.equal(okFallback.statusCode, 200);
            assert.equal(okFallback.body, 'CHAL2');

            const forbidden = await httpRequest(
                port,
                'GET',
                '/webhook?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=CHAL3'
            );
            assert.equal(forbidden.statusCode, 403);

            const duplicateParam = await httpRequest(
                port,
                'GET',
                '/webhook?hub.mode=subscribe&hub.verify_token=a&hub.verify_token=b&hub.challenge=CHAL4'
            );
            assert.equal(duplicateParam.statusCode, 403);
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('normaliza prefixo Bearer duplicado no WHATSAPP_TOKEN e valida destinatário ausente', async () => {
        process.env.WHATSAPP_TOKEN = 'Bearer EAA-com-prefixo';
        const axiosCalls = [];
        mock.method(axios, 'post', async (url, payload, config) => {
            axiosCalls.push({ url, payload, config });
            return { data: { messages: [{ id: 'wamid.bearer-1' }] } };
        });

        const ok = await enviarMensagemWhatsApp('5555996208688', 'Oi');
        assert.equal(ok.sent, true);
        assert.equal(axiosCalls[0].config.headers.Authorization, 'Bearer EAA-com-prefixo');

        process.env.WHATSAPP_TOKEN = 'Bearer   ';
        const emptyBearer = await enviarMensagemWhatsApp('5555996208688', 'Oi');
        assert.equal(emptyBearer.sent, false);
        assert.equal(emptyBearer.reason, 'missing_credentials');

        process.env.WHATSAPP_TOKEN = 'EAA-valido';
        const missingTo = await enviarMensagemWhatsApp('', 'Oi');
        assert.equal(missingTo.sent, false);
        assert.equal(missingTo.reason, 'missing_recipient');
    });

    it('inicializa Gemini sob demanda via "GEMINI API KEY" e faz fallback se a API falhar', async () => {
        process.env['GEMINI API KEY'] = 'gemini-dynamic-key';
        const client = getAiClient('gemini-dynamic-key');
        assert.ok(client);

        mock.method(client.models, 'generateContent', async () => ({
            text: '  Resposta personalizada da Baby Films!  ',
        }));

        const aiReply = await gerarRespostaAtendimento('Quanto custa?', '5555996208688');
        assert.equal(aiReply, 'Resposta personalizada da Baby Films!');

        mock.restoreAll();
        mock.method(client.models, 'generateContent', async () => {
            throw new Error('Quota exceeded');
        });

        const fallbackReply = await gerarRespostaAtendimento('Quanto custa?', '5555996208688');
        assert.match(fallbackReply, /Baby Films/);
        assert.match(fallbackReply, /https:\/\/youtu\.be\/HLIeDSifwVA/);
    });

    it('lida com eventos ignorados e erro de token ausente sem lançar exceção', async () => {
        const statusEvent = await processWebhookEvent({
            object: 'whatsapp_business_account',
            entry: [{ changes: [{ value: { statuses: [{ id: '1' }] } }] }],
        });
        assert.deepEqual(statusEvent, { processed: false, reason: 'no_messages' });

        const missingTokenResult = await enviarMensagemWhatsApp('5555996208688', 'Teste');
        assert.equal(missingTokenResult.sent, false);
        assert.equal(missingTokenResult.reason, 'missing_credentials');
        assert.equal(missingTokenResult.phoneId, '1532130713305838');

        process.env.WHATSAPP_TOKEN = 'EAA-invalido';
        mock.method(axios, 'post', async () => {
            const err = new Error('Request failed with status code 401');
            err.response = { status: 401, data: { error: { message: 'Invalid OAuth access token.' } } };
            throw err;
        });
        const apiErrorResult = await enviarMensagemWhatsApp('5555996208688', 'Teste');
        assert.equal(apiErrorResult.sent, false);
        assert.equal(apiErrorResult.reason, 'api_error');
        assert.equal(apiErrorResult.phoneId, '1532130713305838');
    });
});
