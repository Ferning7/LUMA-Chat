const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const OAB_VALIDA = '1234';

function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
      // Migração: converter array de strings para array de objetos
      if (db.allUsers && db.allUsers.length > 0 && typeof db.allUsers[0] === 'string') {
        db.allUsers = db.allUsers.map(name => ({ name, role: 'cliente' }));
        saveDB(db);
      }
      return db;
    }
  } catch {}
  return { conversations: {}, allUsers: [] };
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

const online = {};       // socketId -> nome
const nameToSocket = {}; // nome -> socketId

function buildUserList() {
  const db = loadDB();
  return db.allUsers.map(u => ({ name: u.name, role: u.role, online: !!nameToSocket[u.name] }));
}

function broadcastUsers() {
  io.emit('usuarios', buildUserList());
}

app.use(express.static(path.join(__dirname, 'public')));

io.on('connection', (socket) => {

  socket.on('entrar', ({ nome, role, oab } = {}) => {
    if (!nome || typeof nome !== 'string') return;
    nome = nome.trim().slice(0, 30);
    if (!nome) return;

    if (role !== 'advogado' && role !== 'cliente') return;

    if (role === 'advogado' && String(oab || '').trim() !== OAB_VALIDA) {
      socket.emit('entrar_erro', { motivo: 'OAB inválida. Verifique o número e tente novamente.' });
      return;
    }

    // Handle stale socket from crashed/closed tab
    if (nameToSocket[nome]) {
      const oldSocketId = nameToSocket[nome];
      if (io.sockets.sockets.get(oldSocketId)) {
        socket.emit('entrar_erro', { motivo: 'Este nome já está em uso.' });
        return;
      }
      delete online[oldSocketId];
    }

    online[socket.id] = nome;
    nameToSocket[nome] = socket.id;

    const db = loadDB();
    const existing = db.allUsers.find(u => u.name.toLowerCase() === nome.toLowerCase());
    if (!existing) {
      db.allUsers.push({ name: nome, role });
      saveDB(db);
    } else if (existing.role !== role) {
      existing.role = role;
      saveDB(db);
    }

    socket.emit('entrar_ok', { nome, role });
    broadcastUsers();
  });

  socket.on('sair', () => {
    const nome = online[socket.id];
    if (nome) {
      delete nameToSocket[nome];
      delete online[socket.id];
      broadcastUsers();
    }
  });

  socket.on('apagar_conversa', (outroNome) => {
    const eu = online[socket.id];
    if (!eu || !outroNome) return;

    const db = loadDB();
    const key = [eu, outroNome].sort().join('::');
    delete db.conversations[key];
    saveDB(db);

    socket.emit('conversa_apagada', { com: outroNome });
    const recipientSocketId = nameToSocket[outroNome];
    if (recipientSocketId) {
      io.to(recipientSocketId).emit('conversa_apagada', { com: eu });
    }
  });

  socket.on('carregar_historico', (outroNome) => {
    const eu = online[socket.id];
    if (!eu || !outroNome) return;

    const db = loadDB();
    const key = [eu, outroNome].sort().join('::');
    const msgs = (db.conversations[key] || []).sort((a, b) => a.ts - b.ts);
    socket.emit('historico', { com: outroNome, msgs });
  });

  socket.on('mensagem_privada', ({ para, texto }) => {
    const de = online[socket.id];
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

    socket.emit('mensagem_privada', msg);

    const recipientSocketId = nameToSocket[para];
    if (recipientSocketId && recipientSocketId !== socket.id) {
      io.to(recipientSocketId).emit('mensagem_privada', msg);
    }
  });

  socket.on('disconnect', () => {
    const nome = online[socket.id];
    if (nome) {
      delete nameToSocket[nome];
      delete online[socket.id];
      broadcastUsers();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nServidor rodando em http://localhost:${PORT}`);
  console.log(`Acesse no celular pelo IP da sua rede local.\n`);
});
