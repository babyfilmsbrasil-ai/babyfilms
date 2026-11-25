require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Inicializa a SDK do Gemini caso a chave esteja presente
let ai = null;
if (GEMINI_API_KEY) {
    try {
        ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        console.log('🤖 Google Gen AI inicializado com sucesso.');
    } catch (e) {
        console.warn('⚠️ Não foi possível inicializar GoogleGenAI:', e.message);
    }
}

// Prompt e diretrizes de atendimento Baby Films
const SYSTEM_PROMPT = `
Você é a assistente virtual oficial da Baby Films, uma produtora audiovisual especializada em registrar momentos inesquecíveis da infância e da família (festas infantis, aniversários de 1 ano, 15 anos, batizados, formaturas e retrospectivas animadas).
Fundador e Videomaker Principal: Cristiano Lopes Brasil.

Suas diretrizes fundamentais:
1. Tom de voz: Acolhedor, empático, educado, ágil e muito caloroso (use emojis pertinentes como 🎬, ✨, 🎂, 👶).
2. Se o cliente estiver entrando em contato para saber sobre pacotes de aniversário ou filmagem, apresente os diferenciais da Baby Films (gravação cinematográfica, captação com alta sensibilidade aos momentos espontâneos da criança e entrega com edição de ponta).
3. Links úteis para compartilhar quando relevante:
   - Vídeo explicativo Baby Films: https://youtu.be/HLIeDSifwVA
   - Exemplo de Retrospectiva: https://www.youtube.com/watch?v=Co_VO4x0XH8
4. Se o cliente perguntar dados para pagamento ou sinal:
   - Chave Pix: 55996208688 (Titular: Cristiano Lopes Brasil)
5. Se o cliente desejar uma proposta fechada, fechar contrato ou falar diretamente com o videomaker, informe que o Cristiano entrará em contato em breve para acertar os últimos detalhes.
6. Mantenha as mensagens objetivas e fáceis de ler no WhatsApp (evite blocos gigantes de texto).
`.trim();

/**
 * Rota de status básico da aplicação (para checagem do Render/Koyeb)
 */
app.get('/', (req, res) => {
    res.status(200).send('🎬 Webhook da Baby Films (WhatsApp Cloud API) está ativo e rodando!');
});

/**
 * ETAPA 2: Rota GET /webhook (Validação do Webhook com a Meta)
 */
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    console.log(`[VERIFICAÇÃO WEBHOOK] Recebido modo: ${mode}`);

    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
        console.log('✅ Webhook verificado pela Meta com sucesso!');
        return res.status(200).send(challenge);
    } else {
        console.warn('❌ Falha na verificação do token do webhook.');
        return res.sendStatus(403);
    }
});

/**
 * ETAPA 2: Rota POST /webhook (Recebimento de Eventos da Meta)
 */
app.post('/webhook', async (req, res) => {
    // 1. Responde imediatamente com 200 OK para evitar timeout e reenvios da Meta
    res.status(200).send('EVENT_RECEIVED');

    try {
        const body = req.body;

        // Valida se o evento é do WhatsApp
        if (body.object !== 'whatsapp_business_account') {
            return;
        }

        const entry = body.entry?.[0];
        const changes = entry?.changes?.[0];
        const value = changes?.value;

        // Ignora notificações de status (sent, delivered, read) ou mensagens sem corpo
        if (!value || !value.messages || value.messages.length === 0) {
            return;
        }

        const message = value.messages[0];
        const from = message.from; // Número do remetente (ex: "5555999999999")
        const messageType = message.type;

        // Processa mensagens de texto
        if (messageType === 'text') {
            const userText = message.text?.body;
            console.log(`\n📩 [MENSAGEM RECEBIDA] De: ${from} | Texto: "${userText}"`);

            // Gera a resposta inteligente e envia de volta
            const replyText = await gerarRespostaAtendimento(userText, from);
            await enviarMensagemWhatsApp(from, replyText);
        } else {
            console.log(`ℹ️ Mensagem recebida de tipo '${messageType}' ignorada ou sem suporte.`);
        }
    } catch (error) {
        console.error('❌ Erro no processamento do evento POST /webhook:', error);
    }
});

/**
 * ETAPA 3: Lógica de geração de resposta com Gemini ou Fallback
 */
async function gerarRespostaAtendimento(userMessage, fromNumber) {
    if (ai && GEMINI_API_KEY) {
        try {
            console.log('🤖 Gerando resposta personalizada com Gemini...');
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: userMessage,
                config: {
                    systemInstruction: SYSTEM_PROMPT,
                    temperature: 0.7,
                }
            });

            if (response && response.text) {
                return response.text.trim();
            }
        } catch (err) {
            console.error('⚠️ Falha ao chamar API do Gemini, usando resposta de contingência:', err.message);
        }
    }

    // Resposta de contingência caso a chave da IA não esteja definida ou falhe
    return `Olá! Tudo bem? Seja muito bem-vindo(a) à *Baby Films*! 🎬✨\n\nRecebemos a sua mensagem e o *Cristiano* já vai te atender para conversar sobre o registro da sua festa!\n\nEnquanto isso, você pode conferir como funciona o nosso trabalho aqui:\n👉 https://youtu.be/HLIeDSifwVA`;
}

/**
 * ETAPA 3: Função de envio de mensagem via WhatsApp Cloud API Oficial
 */
async function enviarMensagemWhatsApp(to, textBody) {
    if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
        console.error('❌ Erro: PHONE_NUMBER_ID ou WHATSAPP_TOKEN não estão configurados nas variáveis de ambiente!');
        return;
    }

    const url = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

    const payload = {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: {
            body: textBody
        }
    };

    try {
        console.log(`📤 Enviando resposta para ${to}...`);
        const response = await axios.post(url, payload, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });

        console.log(`✅ Mensagem enviada com sucesso! WAMID: ${response.data.messages?.[0]?.id}`);
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem pelo WhatsApp Cloud API:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Detalhes:', JSON.stringify(error.response.data, null, 2));
        } else {
            console.error('Erro:', error.message);
        }
    }
}

// Inicializa o servidor
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`🚀 Servidor Baby Films WhatsApp Cloud API no ar!`);
    console.log(`📡 Porta: ${PORT}`);
    console.log(`🔗 Webhook URL: http://localhost:${PORT}/webhook`);
    console.log(`======================================================\n`);
});
