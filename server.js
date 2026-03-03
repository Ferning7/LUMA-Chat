const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const OAB_VALIDA = '1234';

function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { hash, salt };
}

function checkPassword(password, storedHash, storedSalt) {
  try {
    const { hash } = hashPassword(password, storedSalt);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch {
    return false;
  }
}

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      // Migração: converter array de strings para array de objetos
      if (db.allUsers && db.allUsers.length > 0 && typeof db.allUsers[0] === 'string') {
        db.allUsers = db.allUsers.map(name => ({ name, role: 'cliente' }));
        saveDB(db);
      }
      if (!db.resumos) db.resumos = [];
      return db;
    }
  } catch {}
  return { conversations: {}, allUsers: [], resumos: [] };
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

const online = new Map();       // ws → nome
const nameToSocket = new Map(); // nome → ws
const sessions = new Map();     // token → { nome, role }

function sendTo(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, data }));
  }
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  });
}

function buildUserList() {
  const db = loadDB();
  return db.allUsers.map(u => ({ name: u.name, role: u.role, online: nameToSocket.has(u.name) }));
}

function broadcastUsers() {
  broadcast('usuarios', buildUserList());
}

app.use(express.static(path.join(__dirname, 'public')));

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { type, data } = msg;

    switch (type) {
      case 'entrar':           handleEntrar(ws, data); break;
      case 'sair':             handleSair(ws); break;
      case 'apagar_conversa':  handleApagarConversa(ws, data); break;
      case 'listar_conversas': handleListarConversas(ws); break;
      case 'enviar_resumo':      handleEnviarResumo(ws, data); break;
      case 'carregar_resumos':   handleCarregarResumos(ws); break;
      case 'carregar_historico': handleCarregarHistorico(ws, data); break;
      case 'mensagem_privada':   handleMensagemPrivada(ws, data); break;
      case 'reconectar':         handleReconectar(ws, data); break;
    }
  });

  ws.on('close', () => {
    const nome = online.get(ws);
    if (nome) {
      online.delete(ws);
      nameToSocket.delete(nome);
      broadcastUsers();
    }
  });
});

function handleEntrar(ws, { nome, role, oab, senha } = {}) {
  if (!nome || typeof nome !== 'string') return;
  nome = nome.trim().slice(0, 30);
  if (!nome) return;

  if (role !== 'advogado' && role !== 'cliente' && role !== 'ia') return;

  if (role === 'advogado' && String(oab || '').trim() !== OAB_VALIDA) {
    sendTo(ws, 'entrar_erro', { motivo: 'OAB inválida. Verifique o número e tente novamente.' });
    return;
  }

  const db = loadDB();

  // Normaliza nome para o nome canônico do DB (evita problema de case sensitivity)
  const existing = db.allUsers.find(u => u.name.toLowerCase() === nome.toLowerCase());
  if (existing) nome = existing.name;

  // ── Autenticação por senha (apenas cliente e advogado) ──────────────────
  if (role !== 'ia') {
    const senhaStr = String(senha || '').trim();
    if (senhaStr.length < 6) {
      sendTo(ws, 'entrar_erro', { motivo: 'Senha inválida (mínimo 6 caracteres).' });
      return;
    }

    if (existing) {
      // Usuário já cadastrado: verificar se o role bate
      if (existing.role !== role) {
        sendTo(ws, 'entrar_erro', { motivo: `Usuário "${nome}" está cadastrado como ${existing.role}.` });
        return;
      }
      // Verificar senha
      if (existing.passwordHash) {
        if (!checkPassword(senhaStr, existing.passwordHash, existing.passwordSalt)) {
          sendTo(ws, 'entrar_erro', { motivo: 'Senha incorreta.' });
          return;
        }
      } else {
        // Migração: usuário antigo sem senha — primeira senha define a conta
        const { hash, salt } = hashPassword(senhaStr);
        existing.passwordHash = hash;
        existing.passwordSalt = salt;
        saveDB(db);
      }
    }
    // Se não existe: registro completo feito abaixo
  }
  // ────────────────────────────────────────────────────────────────────────

  // Trata stale connection de aba crashada/fechada
  if (nameToSocket.has(nome)) {
    const oldWs = nameToSocket.get(nome);
    if (oldWs.readyState === WebSocket.OPEN) {
      sendTo(ws, 'entrar_erro', { motivo: 'Este nome já está em uso.' });
      return;
    }
    online.delete(oldWs);
    nameToSocket.delete(nome);
  }

  online.set(ws, nome);
  nameToSocket.set(nome, ws);

  if (!existing) {
    const newUser = { name: nome, role };
    if (role !== 'ia') {
      const { hash, salt } = hashPassword(String(senha).trim());
      newUser.passwordHash = hash;
      newUser.passwordSalt = salt;
    }
    db.allUsers.push(newUser);
    saveDB(db);
  }

  const token = crypto.randomBytes(32).toString('hex');
  ws._sessionToken = token;
  sessions.set(token, { nome, role });
  sendTo(ws, 'entrar_ok', { nome, role, token });
  broadcastUsers();
}

function handleSair(ws) {
  const nome = online.get(ws);
  if (nome) {
    if (ws._sessionToken) sessions.delete(ws._sessionToken);
    online.delete(ws);
    nameToSocket.delete(nome);
    broadcastUsers();
  }
}

function handleReconectar(ws, { token } = {}) {
  if (!token || !sessions.has(token)) {
    sendTo(ws, 'reconectar_erro', {});
    return;
  }

  const { nome, role } = sessions.get(token);

  // Trata stale connection (mesma pessoa, nova aba ou reload)
  if (nameToSocket.has(nome)) {
    const oldWs = nameToSocket.get(nome);
    if (oldWs !== ws) {
      online.delete(oldWs);
      nameToSocket.delete(nome);
    }
  }

  ws._sessionToken = token;
  online.set(ws, nome);
  nameToSocket.set(nome, ws);

  sendTo(ws, 'entrar_ok', { nome, role, token });
  broadcastUsers();
}

function handleApagarConversa(ws, outroNome) {
  const eu = online.get(ws);
  if (!eu || !outroNome) return;

  const db = loadDB();
  const key = [eu, outroNome].sort().join('::');
  delete db.conversations[key];
  saveDB(db);

  sendTo(ws, 'conversa_apagada', { com: outroNome });
  const recipientWs = nameToSocket.get(outroNome);
  if (recipientWs) {
    sendTo(recipientWs, 'conversa_apagada', { com: eu });
  }
}

function handleListarConversas(ws) {
  const eu = online.get(ws);
  if (!eu) return;

  const db = loadDB();
  const lista = [];
  for (const [key, msgs] of Object.entries(db.conversations)) {
    if (!msgs || msgs.length === 0) continue;
    const parts = key.split('::');
    if (parts.length !== 2) continue;
    const [a, b] = parts;
    if (a !== eu && b !== eu) continue;
    const outro = a === eu ? b : a;
    const ultima = msgs[msgs.length - 1];
    lista.push({ com: outro, ultimaMensagem: ultima.texto, hora: ultima.hora, ts: ultima.ts });
  }
  lista.sort((a, b) => b.ts - a.ts);
  sendTo(ws, 'lista_conversas', lista);
}

function handleEnviarResumo(ws, { titulo, conteudo } = {}) {
  const de = online.get(ws);
  if (!de || !titulo || !conteudo) return;
  titulo   = String(titulo).trim().slice(0, 100);
  conteudo = String(conteudo).trim().slice(0, 2000);
  if (!titulo || !conteudo) return;

  const agora = new Date();
  const resumo = {
    de,
    titulo,
    conteudo,
    hora: agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    data: agora.toLocaleDateString('pt-BR'),
    ts: Date.now()
  };

  const db = loadDB();
  if (!db.resumos) db.resumos = [];
  db.resumos.push(resumo);
  saveDB(db);

  db.allUsers
    .filter(u => u.role === 'advogado')
    .forEach(u => {
      const lawyerWs = nameToSocket.get(u.name);
      if (lawyerWs) sendTo(lawyerWs, 'novo_resumo', resumo);
    });

  sendTo(ws, 'resumo_enviado', {});
}

function handleCarregarResumos(ws) {
  const eu = online.get(ws);
  if (!eu) return;
  const db = loadDB();
  const user = db.allUsers.find(u => u.name === eu);
  if (!user || user.role !== 'advogado') return;
  sendTo(ws, 'lista_resumos', db.resumos || []);
}

function handleCarregarHistorico(ws, outroNome) {
  const eu = online.get(ws);
  if (!eu || !outroNome) return;

  const db = loadDB();
  const key = [eu, outroNome].sort().join('::');
  const msgs = (db.conversations[key] || []).sort((a, b) => a.ts - b.ts);
  sendTo(ws, 'historico', { com: outroNome, msgs });
}

function handleMensagemPrivada(ws, { para, texto } = {}) {
  const de = online.get(ws);
  if (!de || !para || !texto) return;
  texto = String(texto).trim().slice(0, 500);
  if (!texto) return;

  const msg = {
    de,
    para,
    texto,
    hora: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }),
    ts: Date.now()
  };

  const db = loadDB();
  const key = [de, para].sort().join('::');
  if (!db.conversations[key]) db.conversations[key] = [];
  db.conversations[key].push(msg);
  saveDB(db);

  sendTo(ws, 'mensagem_privada', msg);
  const recipientWs = nameToSocket.get(para);
  if (recipientWs && recipientWs !== ws) {
    sendTo(recipientWs, 'mensagem_privada', msg);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nServidor rodando em http://localhost:${PORT}`);
  console.log(`Acesse no celular pelo IP da sua rede local.\n`);
});
