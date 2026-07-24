//#region ARGO'S - WhatsApp & API Bridge (Multi-Device)

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, delay, Browsers } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const pino = require('pino'); 
require('dotenv').config();

// --- PROTEÇÃO GLOBAL CONTRA QUEDAS ---
process.on('uncaughtException', (err) => {
    console.error('[ERRO CRÍTICO NÃO TRATADO]:', err?.message || err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[PROMISE REJEITADA NÃO TRATADA]:', reason?.message || reason);
});

process.on('SIGTERM', () => {
    console.log('\n[SISTEMA] Sinal SIGTERM recebido. Salvando estado e encerrando com segurança...');
    process.exit(0);
});

// --- DIRETÓRIO BASE ---
const authBaseFolder = './auth';
if (!fs.existsSync(authBaseFolder)) {
    fs.mkdirSync(authBaseFolder, { recursive: true });
}

// --- SERVIDOR EXPRESS ---
const app = express();
// Aumento do limite do JSON, pois dados de sessão podem ser grandes
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
const PORT = process.env.PORT || 8080;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

app.get('/', (req, res) => {
    res.status(200).send("ARGO'S MULTI-DEVICE SYSTEM ONLINE!");
});

// --- PROMPT DA IA ---
const PROMPT_ARGOS = `Você é o ARGO'S, o assistente virtual inteligente oficial.
Unidade: Angra dos Reis.
Site de Gestão: gestaopro-five.vercel.app

Diretrizes de Resposta:
1. Sempre se apresente como ARGO'S da unidade Angra dos Reis.
2. Use as informações do site gestaopro-five.vercel.app para ajudar os clientes.
3. Mantenha um tom profissional, tecnológico e ágil.
4. Respostas curtas e objetivas (estilo WhatsApp).
5. Se o atendimento automático estiver desativado no sistema, você não deve responder.
6. Nunca invente dados de pedidos. Direcione o cliente para o painel do site se necessário.`;

const botInstances = {};

// --- PROCESSADOR DE FILA (ESTRATÉGIA QUEBRA-GELO + 40s PAUSA) ---
async function processQueue(botNumber) {
    const instance = botInstances[botNumber];
    if (!instance || instance.isDeleted) return;

    while (instance.sendQueue && instance.sendQueue.length > 0) {
        if (!botInstances[botNumber] || botInstances[botNumber].isDeleted) return;

        if (instance.status !== 'online' || !instance.sock) {
            console.log(`[FILA] Bot ${botNumber} está offline. Fila em pausa. A aguardar...`);
            await delay(5000);
            continue; 
        }

        const { jid, text, clientName } = instance.sendQueue.shift();
        
        try {
            let targetJid = jid;
            try {
                const [waStatus] = await instance.sock.onWhatsApp(jid);
                if (waStatus && waStatus.exists) {
                    targetJid = waStatus.jid; 
                }
            } catch (errCheck) {
                console.log(`[AVISO] Falha ao verificar número na Meta. Tentando entrega direta...`);
            }

            // === FASE 1: O QUEBRA GELO ===
            const firstName = clientName ? clientName.trim().split(' ')[0] : '';
            const greeting = firstName ? `Olá ${firstName}, tudo bem?` : `Olá, tudo bem?`;
            const botProfileName = instance.sock.authState?.creds?.me?.name || "Consultor";
            
            const icebreakerText = `${greeting}\nMeu nome é ${botProfileName}, sou Consultor educacional da Estácio Angra dos reis...`;

            await instance.sock.sendPresenceUpdate('composing', targetJid);
            await delay(3000 + Math.floor(Math.random() * 2000));
            await instance.sock.sendPresenceUpdate('paused', targetJid);
            await instance.sock.sendMessage(targetJid, { text: icebreakerText });
            console.log(`[QUEBRA-GELO] Enviado para ${targetJid}`);

            // === FASE 2: A ESPERA HUMANIZADA ===
            console.log(`[AGUARDANDO] 40s de pausa tática para ${targetJid}...`);
            await delay(35000); 
            
            await instance.sock.sendPresenceUpdate('composing', targetJid);
            const typeTime = 5000 + Math.floor(Math.random() * 3000);
            await delay(typeTime);

            // === FASE 3: A MENSAGEM PRINCIPAL ===
            await instance.sock.sendPresenceUpdate('paused', targetJid);
            await instance.sock.sendMessage(targetJid, { text });
            console.log(`[DISPARO PRINCIPAL] Mensagem entregue a ${targetJid} | Fila Restante:${instance.sendQueue.length}`);

            const safeDelay = 4000 + Math.floor(Math.random() * 3000);
            await delay(safeDelay);

        } catch (e) {
            console.error(`[ERRO DISPARO] Falha ao enviar para ${jid}:`, e.message || e);
            if (e.message && e.message.toLowerCase().includes('closed') && botInstances[botNumber] && !botInstances[botNumber].isDeleted) {
                botInstances[botNumber].sendQueue.unshift({ jid, text, clientName });
            }
        }
    }
    
    if (botInstances[botNumber]) {
        botInstances[botNumber].isProcessingQueue = false;
    }
}

// --- INICIALIZADOR DO BOT ---
async function startBot(botNumber, isExplicit = false) {
    
    if (!isExplicit && botInstances[botNumber] && botInstances[botNumber].isDeleted) {
        return;
    }

    if (botInstances[botNumber] && (botInstances[botNumber].status === 'initializing' || botInstances[botNumber].status === 'pairing') && !botInstances[botNumber].isDeleted) {
        return;
    }

    if (botInstances[botNumber] && botInstances[botNumber].sock && botInstances[botNumber].status === 'online') {
        return;
    }

    if (isExplicit && botInstances[botNumber] && botInstances[botNumber].isDeleted) {
        delete botInstances[botNumber];
    }

    console.log(`[BOT] Iniciando ligação para o número: ${botNumber}...`);
    
    const authFolder = `${authBaseFolder}/${botNumber}`;
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    if (!botInstances[botNumber]) {
        botInstances[botNumber] = {
            sock: null,
            isAutoReplyActive: false, 
            sessions: {},
            status: 'initializing',
            pairingCode: null,
            qr: null,
            sendQueue: [], 
            isProcessingQueue: false,
            isDeleted: false 
        };
    } else {
        botInstances[botNumber].status = 'initializing';
        botInstances[botNumber].isDeleted = false;
    }

    try {
        const { version } = await fetchLatestBaileysVersion();
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);

        const sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }), 
            printQRInTerminal: false,
            // 🛡️ ANTI-BAN TWEAK: Alterado de Ubuntu/Chrome obsoleto para macOS (assinatura oficial padrão Meta)
            browser: Browsers.macOS('Desktop'), 
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 30000, 
            syncFullHistory: false, 
            generateHighQualityLinkPreview: false, 
            markOnlineOnConnect: false 
        });

        if (botInstances[botNumber]) botInstances[botNumber].sock = sock;

        sock.ev.on('creds.update', saveCreds);

        if (!state.creds.registered) {
            if (botInstances[botNumber]) botInstances[botNumber].status = 'pairing';
            
            setTimeout(async () => {
                if (!botInstances[botNumber] || botInstances[botNumber].isDeleted) return;
                try {
                    const code = await sock.requestPairingCode(botNumber);
                    if (botInstances[botNumber] && !botInstances[botNumber].isDeleted) {
                        botInstances[botNumber].pairingCode = code;
                        console.log(`\n=== CÓDIGO PARA ${botNumber}:${code} ===\n`);
                    }
                } catch (error) {
                    console.error(`[ERRO] Falha ao solicitar código para ${botNumber}:`, error.message);
                    if (botInstances[botNumber]) botInstances[botNumber].status = 'error';
                }
            }, 6000);
        }

        sock.ev.on('connection.update', (update) => {
            if (!botInstances[botNumber] || botInstances[botNumber].isDeleted) return;

            const { connection, lastDisconnect, qr } = update;

            if (qr && botInstances[botNumber]) {
                botInstances[botNumber].qr = qr; 
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                if (botInstances[botNumber]) botInstances[botNumber].status = 'offline';
                
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                const isLogout = statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403;
                const isRestartRequired = statusCode === DisconnectReason.restartRequired || statusCode === 515;
                
                if (isRestartRequired) {
                    if (botInstances[botNumber]) botInstances[botNumber].sock = null; 
                    setTimeout(() => startBot(botNumber, false), 2000); 
                } 
                else if (isLogout) {
                    console.log(`[SISTEMA] A Meta recusou a ligação (Erro ${statusCode}). Limpando memória...`);
                    try { fs.rmSync(authFolder, { recursive: true, force: true }); } catch(e) {}
                    if (botInstances[botNumber]) botInstances[botNumber].isDeleted = true;
                } else {
                    if (botInstances[botNumber]) botInstances[botNumber].sock = null; 
                    setTimeout(() => startBot(botNumber, false), 5000); 
                }
            } else if (connection === 'open') {
                if (botInstances[botNumber]) {
                    botInstances[botNumber].status = 'online';
                    botInstances[botNumber].pairingCode = null; 
                    botInstances[botNumber].qr = null; 
                }
                console.log(`\n--- ARGO\'S ONLINE: ${botNumber} ---\n`);
            }
        });

        sock.ev.on("messages.upsert", async m => {
            if (m.type !== "notify") return;
            let msg = m.messages[0];
            if (!msg.message || msg.key.fromMe || msg.key.remoteJid?.endsWith("@g.us")) return;
            
            const messageTimestamp = msg.messageTimestamp;
            if (messageTimestamp) {
                const nowInSeconds = Math.floor(Date.now() / 1000);
                if (nowInSeconds - messageTimestamp > 60) return; 
            }

            if (!botInstances[botNumber] || !botInstances[botNumber].isAutoReplyActive || botInstances[botNumber].isDeleted) return;

            const jid = msg.key.remoteJid;
            const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || "";
            if (!text) return;

            await handleAIProcess(botNumber, jid, text);
        });

    } catch (error) {
        if (!botInstances[botNumber] || botInstances[botNumber].isDeleted) return;
        if (botInstances[botNumber]) {
            botInstances[botNumber].status = 'error';
            botInstances[botNumber].sock = null; 
        }
        setTimeout(() => startBot(botNumber, false), 10000);
    }
}

// --- INTEGRAÇÃO IA OPENROUTER ---
async function handleAIProcess(botNumber, jid, text) {
    const instance = botInstances[botNumber];
    if (!instance || instance.isDeleted) return; 

    if (!instance.sessions[jid]) instance.sessions[jid] = { chat: [], lastActive: Date.now() };
    
    const session = instance.sessions[jid];
    session.lastActive = Date.now(); 
    session.chat.push({ role: "user", content: text });
    if (session.chat.length > 10) session.chat.shift();

    const apiKey = process.env.OPENROUTER_API_KEY;
    
    if (!apiKey || apiKey.trim() === "") {
        console.log(`[AVISO] API Key da OpenRouter não encontrada!`);
        return;
    }

    try {
        await instance.sock.sendPresenceUpdate("composing", jid);

        const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${apiKey}`,
                "Content-Type": "application/json",
                "HTTP-Referer": "https://gestaopro-five.vercel.app", 
                "X-Title": "ARGO'S Bot" 
            },
            body: JSON.stringify({
                model: "meta-llama/llama-3.1-8b-instruct", 
                messages: [{ role: "system", content: PROMPT_ARGOS }, ...session.chat],
                temperature: 0.6
            })
        });

        const data = await response.json();
        
        if (data.error) {
            console.error(`[ERRO OPENROUTER]:`, data.error.message);
            return;
        }

        const reply = data.choices && data.choices[0]?.message?.content ? data.choices[0].message.content : "Estou a processar a sua dúvida.";
        
        session.chat.push({ role: "assistant", content: reply });
        
        const typeTime = Math.min(reply.length * 15, 3000);
        await delay(typeTime);
        
        if (botInstances[botNumber] && !botInstances[botNumber].isDeleted) {
            await instance.sock.sendPresenceUpdate("paused", jid);
            await instance.sock.sendMessage(jid, { text: reply });
        }
    } catch (err) {
        console.error(`[ERRO AI]:`, err.message || err);
    }
}

// --- LIMPEZA DE MEMÓRIA (GARBAGE COLLECTOR) ---
setInterval(() => {
    const now = Date.now();
    for (const botNumber of Object.keys(botInstances)) {
        const instance = botInstances[botNumber];
        if (instance && instance.sessions && !instance.isDeleted) {
            for (const [jid, session] of Object.entries(instance.sessions)) {
                if (now - session.lastActive > 1800000) delete instance.sessions[jid];
            }
        }
    }
}, 600000);

// --- ROTAS DA API ---
function formatNumberBR(number) {
    let clean = number.toString().replace(/\D/g, '');
    if (clean.length === 13 && clean.substring(0, 2) === clean.substring(2, 4)) clean = clean.substring(2);
    if ((clean.length === 10 || clean.length === 11) && !clean.startsWith('55')) clean = '55' + clean;
    return clean;
}

// 🆕 NOVA ROTA: INJEÇÃO DE SESSÃO (Bypass Passkey) 🆕
app.post('/api/inject', async (req, res) => {
    const { botNumber, sessionData } = req.body;
    
    if (!botNumber || !sessionData) {
        return res.status(400).json({ error: "Parâmetros 'botNumber' e 'sessionData' são obrigatórios." });
    }

    const cleanNumber = formatNumberBR(botNumber);
    const authFolder = `${authBaseFolder}/${cleanNumber}`;

    try {
        // 1. Limpa qualquer sessão antiga que possa gerar conflito
        if (fs.existsSync(authFolder)) {
            fs.rmSync(authFolder, { recursive: true, force: true });
        }
        fs.mkdirSync(authFolder, { recursive: true });

        // 2. Extrai e salva os arquivos do JSON fornecido pela extensão
        // Extensões costumam jogar um objeto onde a chave é o nome do arquivo (ex: "creds.json")
        for (const [key, value] of Object.entries(sessionData)) {
            // Garante que o arquivo tenha a extensão .json
            let fileName = key;
            if (!fileName.endsWith('.json')) {
                fileName = `${fileName}.json`;
            }
            
            // Converte para string caso venha como objeto aninhado
            const fileContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            
            // Grava o arquivo direto na pasta de auth do bot
            fs.writeFileSync(`${authFolder}/${fileName}`, fileContent);
        }

        console.log(`[INJECTOR] Credenciais salvas com sucesso em ${authFolder}. Iniciando bot...`);

        // 3. Força o encerramento de qualquer instância anterior presa na memória
        if (botInstances[cleanNumber] && botInstances[cleanNumber].sock) {
            botInstances[cleanNumber].sock.end(undefined);
            botInstances[cleanNumber].isDeleted = true;
            await delay(1000);
        }

        // 4. Inicia o Bot carregando a pasta que acabamos de preencher
        await startBot(cleanNumber, true);
        
        res.json({ success: true, message: `Sessão injetada e bot ${cleanNumber} está iniciando nativamente.` });

    } catch (error) {
        console.error('[ERRO INJEÇÃO]:', error);
        res.status(500).json({ error: "Falha ao gravar os arquivos de credenciais.", details: error.message });
    }
});

app.post('/api/connect', async (req, res) => {
    const { botNumber } = req.body;
    if (!botNumber) return res.status(400).json({ error: "O campo 'botNumber' é obrigatório." });
    const cleanNumber = formatNumberBR(botNumber);
    
    await startBot(cleanNumber, true); 
    
    res.json({ success: true, message: `Processo iniciado para ${cleanNumber}.` });
});

app.post('/api/send', (req, res) => {
    const { botNumber, number, message, contactName } = req.body;
    
    if (!botNumber || !number || !message) return res.status(400).json({ error: "Campos obrigatórios em falta." });

    const cleanBotNumber = formatNumberBR(botNumber);
    const instance = botInstances[cleanBotNumber];
    
    if (!instance || !instance.sock || instance.status !== 'online' || instance.isDeleted) {
        return res.status(503).json({ error: `O bot não está ligado.` });
    }

    const jid = `${formatNumberBR(number)}@s.whatsapp.net`;
    if (!instance.sendQueue) instance.sendQueue = [];
    if (instance.sendQueue.length > 5000) return res.status(429).json({ error: "Fila cheia." });

    instance.sendQueue.push({ jid, text: message, clientName: contactName || "" });

    if (!instance.isProcessingQueue) {
        instance.isProcessingQueue = true;
        processQueue(cleanBotNumber);
    }
    res.json({ success: true, message: `Adicionado à fila.` });
});

app.post('/api/toggle', (req, res) => {
    const { botNumber, active } = req.body;
    if (!botNumber) return res.status(400).json({ error: "Falta botNumber." });
    
    const cleanBotNumber = formatNumberBR(botNumber);
    if (botInstances[cleanBotNumber] && !botInstances[cleanBotNumber].isDeleted) {
        botInstances[cleanBotNumber].isAutoReplyActive = active === true;
        res.json({ success: true, active: botInstances[cleanBotNumber].isAutoReplyActive });
    } else {
        res.status(404).json({ error: `Bot não encontrado.` });
    }
});

app.post('/api/reset', (req, res) => {
    const { botNumber } = req.body;
    if (!botNumber) return res.status(400).json({ error: "Falta botNumber." });

    const cleanNumber = formatNumberBR(botNumber);
    const authFolder = `${authBaseFolder}/${cleanNumber}`;
    
    try {
        const instance = botInstances[cleanNumber];
        if (instance) {
            instance.isDeleted = true;
            instance.status = 'offline';
            if (instance.sock) {
                instance.sock.logout().catch(() => {});
                instance.sock.end(undefined);
                if (instance.sock.ws) instance.sock.ws.close();
            }
        } else {
            botInstances[cleanNumber] = { isDeleted: true, status: 'offline' };
        }

        if (fs.existsSync(authFolder)) fs.rmSync(authFolder, { recursive: true, force: true });
        
        console.log(`[SISTEMA] Conexão ${cleanNumber} eliminada e bloqueada até religação manual.`);
        res.json({ success: true, message: `Sessão apagada e bloqueada com sucesso.` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/status', (req, res) => {
    const statusData = {};
    for (const [number, instance] of Object.entries(botInstances)) {
        if (!instance.isDeleted) {
            statusData[number] = {
                status: instance.status,
                autoReply: instance.isAutoReplyActive,
                pairingCode: instance.pairingCode,
                qrCode: instance.qr, 
                queueLength: instance.sendQueue ? instance.sendQueue.length : 0
            };
        }
    }
    res.json({ system: "ARGO'S MULTI-DEVICE", uptime: process.uptime(), bots: statusData });
});

// --- RADAR DE ERROS 404 (DETETOR) ---
app.use((req, res) => {
    console.log(`\n❌ [ALERTA 404] O GestãoPro tentou chamar uma rota desconhecida:`);
    console.log(`👉 Método: ${req.method}`);
    console.log(`👉 Caminho (URL): ${req.url}`);
    console.log(`------------------------------------------------------\n`);
    res.status(404).json({ error: "Rota não encontrada pelo ARGO'S", path: req.url });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] API a correr em 0.0.0.0:${PORT}`);
    setTimeout(() => {
        try {
            const folders = fs.readdirSync(authBaseFolder);
            folders.forEach(folder => {
                if (/^\d+$/.test(folder)) startBot(folder, false); 
            });
        } catch (e) {}
    }, 5000);
});
