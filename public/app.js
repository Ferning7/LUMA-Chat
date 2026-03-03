// Wrapper de WebSocket nativo com API compatível com socket.io
const socket = (() => {
  let ws;
  const handlers = {};
  let intentionalClose = false;

  function reconectar() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}`);

    ws.onopen = () => {
      let session = null;
      try { session = JSON.parse(localStorage.getItem('luma_session')); } catch {}
      if (session && session.token) {
        ws.send(JSON.stringify({ type: 'reconectar', data: { token: session.token } }));
      } else {
        (handlers['connect'] || []).forEach(fn => fn());
      }
    };

    ws.onclose = () => {
      if (!intentionalClose) setTimeout(reconectar, 2000);
    };

    ws.onmessage = (event) => {
      try {
        const { type, data } = JSON.parse(event.data);
        (handlers[type] || []).forEach(fn => fn(data));
      } catch {}
    };
  }

  reconectar();

  return {
    on(event, fn) {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(fn);
    },
    emit(event, data) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: event, data }));
      }
    },
    disconnect() {
      intentionalClose = true;
      if (ws) ws.close();
    },
    connect() {
      intentionalClose = false;
      reconectar();
    }
  };
})();

// ===== Estado =====
let meuNome   = null;
let meuRole   = 'cliente';
let meuOAB    = '';
let activeChat = null;
let allUsers   = [];
let conversasAtivas = []; // { com, ultimaMensagem, hora, ts }
let unread    = {};
let historicoCache = {};

// ===== SVG helpers =====
const SVG_LUA = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const SVG_SOL = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

// ===== Tema =====
const isDark = () => document.body.classList.contains('dark');

if (localStorage.getItem('luma-tema') === 'dark') {
  document.body.classList.add('dark');
}

function atualizarIconeTema() {
  document.getElementById('botao-tema').innerHTML = isDark() ? SVG_SOL : SVG_LUA;
}

document.getElementById('botao-tema').addEventListener('click', () => {
  document.body.classList.toggle('dark');
  localStorage.setItem('luma-tema', isDark() ? 'dark' : 'light');
  atualizarIconeTema();
});

atualizarIconeTema();

// ===== Avatar =====
const CORES = ['#7859e9','#c4314b','#0078d4','#107c10','#ca5010','#038387','#8764b8','#e3008c'];

function corAvatar(nome) {
  let h = 0;
  for (const c of nome) h = (h * 31 + c.charCodeAt(0)) & 0xffffffff;
  return CORES[Math.abs(h) % CORES.length];
}

function iniciais(nome) {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 1) return partes[0].slice(0, 2).toUpperCase();
  return (partes[0][0] + partes[partes.length - 1][0]).toUpperCase();
}

function preencherAvatar(el, nome, tamanho = 44) {
  el.style.background = corAvatar(nome);
  el.style.width = tamanho + 'px';
  el.style.height = tamanho + 'px';
  el.style.fontSize = Math.round(tamanho * 0.36) + 'px';
  el.textContent = iniciais(nome);
}

// ===== DOM =====
const telaEntrada      = document.getElementById('tela-login');
const appEl            = document.getElementById('aplicativo');
const inputNome        = document.getElementById('campo-nome');
const btnEntrar        = document.getElementById('botao-entrar');
const erroLogin        = document.getElementById('aviso-erro-login');
const meuAvatar        = document.getElementById('avatar-usuario');
const meuNomeEl        = document.getElementById('nome-usuario');
const convListPanel    = document.getElementById('painel-lista-conversas');
const listaConversas   = document.getElementById('lista-conversas');
const chatArea         = document.getElementById('area-chat');
const chatVazio        = document.getElementById('aviso-chat-vazio');
const chatContent      = document.getElementById('conteudo-chat');
const parceiroAvatar   = document.getElementById('contato-avatar');
const parceiroNome     = document.getElementById('contato-nome');
const parceiroStatus   = document.getElementById('contato-status');
const mensagensDiv     = document.getElementById('lista-mensagens');
const inputMensagem    = document.getElementById('campo-mensagem');
const btnEnviar        = document.getElementById('botao-enviar');
const btnSair          = document.getElementById('botao-sair');
const btnVoltarHeader  = document.getElementById('botao-voltar');
const btnApagar        = document.getElementById('botao-apagar-conversa');
const modalApagar      = document.getElementById('modal-confirmar-exclusao');
const modalOverlay     = document.getElementById('modal-fundo');
const btnCancelarApagar  = document.getElementById('botao-cancelar-exclusao');
const btnConfirmarApagar = document.getElementById('botao-confirmar-exclusao');

// ===== Seletor de perfil =====
const btnRoleCliente  = document.getElementById('botao-perfil-cliente');
const btnRoleAdvogado = document.getElementById('botao-perfil-advogado');
const btnRoleIA       = document.getElementById('botao-perfil-ia');
const oabField        = document.getElementById('campo-oab');
const inputOAB        = document.getElementById('campo-oab-numero');
const inputSenha      = document.getElementById('campo-senha');
const senhaHint       = document.getElementById('senha-hint');

function selecionarRole(role) {
  meuRole = role;
  btnRoleCliente.classList.toggle('ativo',  role === 'cliente');
  btnRoleAdvogado.classList.toggle('ativo', role === 'advogado');
  btnRoleIA.classList.toggle('ativo',       role === 'ia');
  oabField.hidden = role !== 'advogado';
  if (role !== 'advogado') inputOAB.value = '';
  // Campo de senha oculto apenas para IA
  inputSenha.hidden = role === 'ia';
  senhaHint.hidden  = role === 'ia';
  if (role === 'ia') inputSenha.value = '';
}

selecionarRole('cliente');

btnRoleCliente.addEventListener('click',  () => selecionarRole('cliente'));
btnRoleAdvogado.addEventListener('click', () => selecionarRole('advogado'));
btnRoleIA.addEventListener('click',       () => selecionarRole('ia'));

// ===== Login =====
function entrar() {
  const nome = inputNome.value.trim();
  if (!nome) return;

  if (meuRole !== 'ia') {
    const senha = inputSenha.value.trim();
    if (!senha) {
      erroLogin.textContent = 'Informe sua senha.';
      erroLogin.hidden = false;
      return;
    }
    if (senha.length < 6) {
      erroLogin.textContent = 'Senha muito curta (mínimo 6 caracteres).';
      erroLogin.hidden = false;
      return;
    }
  }

  if (meuRole === 'advogado') {
    const oab = inputOAB.value.trim();
    if (!oab) {
      erroLogin.textContent = 'Informe o número OAB.';
      erroLogin.hidden = false;
      return;
    }
    if (!/^\d+$/.test(oab)) {
      erroLogin.textContent = 'OAB fora do padrão. Use apenas números.';
      erroLogin.hidden = false;
      return;
    }
    meuOAB = oab;
  }

  erroLogin.hidden = true;
  socket.emit('entrar', { nome, role: meuRole, oab: meuOAB, senha: inputSenha.value.trim() });
}

btnEntrar.addEventListener('click', entrar);
inputNome.addEventListener('keydown',  e => { if (e.key === 'Enter') entrar(); });
inputSenha.addEventListener('keydown', e => { if (e.key === 'Enter') entrar(); });
inputOAB.addEventListener('keydown',   e => { if (e.key === 'Enter') entrar(); });

socket.on('entrar_ok', ({ nome, role, token }) => {
  historicoCache = {};
  if (token) localStorage.setItem('luma_session', JSON.stringify({ token, nome, role }));
  meuNome = nome;
  meuRole = role;
  telaEntrada.style.display = 'none';
  appEl.style.display = 'flex';
  preencherAvatar(meuAvatar, nome, 30);
  meuNomeEl.textContent = nome;
  // Aba Clientes/Advogados: oculta apenas para role 'ia'
  const navBtnContatos = document.querySelector('.botao-nav[data-tab="clientes"]');
  if (navBtnContatos) {
    navBtnContatos.style.display = role === 'ia' ? 'none' : '';
    navBtnContatos.querySelector('span').textContent = role === 'advogado' ? 'Clientes' : 'Advogados';
  }
  const tituloContatos = document.getElementById('titulo-contatos');
  if (tituloContatos) tituloContatos.textContent = role === 'advogado' ? 'Clientes' : 'Advogados';

  // Role IA: mostra painel de envio, esconde corpo-principal
  const mainBodyEl = document.getElementById('corpo-principal');
  const iaSenderEl = document.getElementById('painel-envio-resumo');
  if (role === 'ia') {
    mainBodyEl.style.display = 'none';
    iaSenderEl.style.display = 'flex';
  } else {
    mainBodyEl.style.display = '';
    iaSenderEl.style.display = 'none';
    socket.emit('listar_conversas');
    if (role === 'advogado') socket.emit('carregar_resumos');
  }
});

socket.on('entrar_erro', ({ motivo }) => {
  erroLogin.textContent = motivo;
  erroLogin.hidden = false;
});

// ===== Navegação por abas =====
function trocarTab(tab) {
  document.querySelectorAll('.botao-nav').forEach(btn => {
    btn.classList.toggle('ativo', btn.dataset.tab === tab);
  });
  document.querySelectorAll('.painel-aba').forEach(panel => {
    panel.hidden = panel.id !== 'aba-' + tab;
  });
  if (tab === 'clientes') renderizarClientes();
}

document.querySelectorAll('.botao-nav').forEach(btn => {
  btn.addEventListener('click', () => trocarTab(btn.dataset.tab));
});

// ===== Sair =====
btnSair.addEventListener('click', () => {
  socket.emit('sair');
  localStorage.removeItem('luma_session');
  socket.disconnect();

  meuNome = null;
  activeChat = null;
  allUsers = [];
  conversasAtivas = [];
  unread = {};
  historicoCache = {};

  appEl.style.display = 'none';
  telaEntrada.style.display = 'flex';
  inputNome.value  = '';
  inputSenha.value = '';
  erroLogin.hidden = true;
  chatContent.style.display = 'none';
  chatVazio.style.display = 'flex';
  convListPanel.classList.remove('oculto');
  chatArea.classList.remove('expandido');
  btnVoltarHeader.classList.remove('visivel');
  // Restaura nav e visibilidade para o próximo login
  const navBtnContatos = document.querySelector('.botao-nav[data-tab="clientes"]');
  if (navBtnContatos) {
    navBtnContatos.style.display = '';
    navBtnContatos.querySelector('span').textContent = 'Clientes';
  }
  document.getElementById('corpo-principal').style.display = '';
  document.getElementById('painel-envio-resumo').style.display = 'none';
  document.getElementById('campo-titulo-resumo').value = '';
  document.getElementById('campo-conteudo-resumo').value = '';
  trocarTab('chat');

  setTimeout(() => socket.connect(), 150);
});

// ===== Lista de conversas (Chat tab) =====
socket.on('lista_conversas', (lista) => {
  conversasAtivas = lista;
  renderizarConversas();
});

function renderizarConversas() {
  listaConversas.innerHTML = '';

  if (conversasAtivas.length === 0) {
    const empty = document.createElement('div');
    empty.id = 'aviso-sem-conversas';
    empty.innerHTML = 'Nenhuma conversa ainda.<br>Vá em <strong>Clientes</strong> para iniciar.';
    listaConversas.appendChild(empty);
    return;
  }

  conversasAtivas.forEach(conv => {
    const item = document.createElement('div');
    item.className = 'item-conversa' + (conv.com === activeChat ? ' ativo' : '');
    item.dataset.nome = conv.com;

    const av = document.createElement('div');
    av.className = 'avatar';
    preencherAvatar(av, conv.com, 44);
    const user = allUsers.find(u => u.name === conv.com);
    const isOnline = user?.online || false;
    const dot = document.createElement('div');
    dot.className = 'bolinha-status' + (isOnline ? ' online' : '');
    av.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'info-conversa';
    const nomeEl = document.createElement('div');
    nomeEl.className = 'nome-conversa';
    nomeEl.textContent = conv.com;
    const preview = document.createElement('div');
    preview.className = 'preview-conversa';
    preview.textContent = conv.ultimaMensagem || '';
    info.appendChild(nomeEl);
    info.appendChild(preview);

    const right = document.createElement('div');
    right.className = 'lado-direito-conversa';
    const hora = document.createElement('span');
    hora.className = 'hora-conversa';
    hora.textContent = conv.hora || '';
    const badge = document.createElement('div');
    badge.className = 'contador-nao-lido' + ((unread[conv.com] || 0) > 0 ? ' visivel' : '');
    badge.textContent = (unread[conv.com] || 0) > 99 ? '99+' : (unread[conv.com] || '');
    right.appendChild(hora);
    right.appendChild(badge);

    const btnLixeira = document.createElement('button');
    btnLixeira.className = 'botao-apagar-na-lista';
    btnLixeira.title = 'Apagar conversa';
    btnLixeira.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>`;
    btnLixeira.addEventListener('click', e => {
      e.stopPropagation();
      abrirModalApagar(conv.com);
    });

    item.appendChild(av);
    item.appendChild(info);
    item.appendChild(right);
    item.appendChild(btnLixeira);
    item.addEventListener('click', () => abrirConversa(conv.com));
    listaConversas.appendChild(item);
  });
}

// ===== Lista de todos os usuários (Clientes tab) =====
socket.on('usuarios', (lista) => {
  allUsers = lista;
  renderizarConversas();
  renderizarClientes();
  atualizarChatHeader();
});

function renderizarClientes() {
  const listaEl = document.getElementById('lista-contatos');
  listaEl.innerHTML = '';

  const roleAlvo = meuRole === 'advogado' ? 'cliente' : 'advogado';
  const outros = allUsers.filter(u => u.name !== meuNome && u.role === roleAlvo);

  if (outros.length === 0) {
    const aviso = document.createElement('div');
    aviso.className = 'aviso-lista-vazia';
    aviso.textContent = 'Nenhuma pessoa cadastrada ainda.';
    listaEl.appendChild(aviso);
    return;
  }

  outros.sort((a, b) => {
    if (a.online !== b.online) return b.online - a.online;
    return a.name.localeCompare(b.name);
  });

  outros.forEach(u => {
    const item = document.createElement('div');
    item.className = 'item-contato';

    const av = document.createElement('div');
    av.className = 'avatar';
    preencherAvatar(av, u.name, 44);
    const dot = document.createElement('div');
    dot.className = 'bolinha-status' + (u.online ? ' online' : '');
    av.appendChild(dot);

    const info = document.createElement('div');
    info.className = 'info-contato';
    const nomeEl = document.createElement('div');
    nomeEl.className = 'nome-contato';
    nomeEl.textContent = u.name;
    const statusEl = document.createElement('div');
    statusEl.className = 'status-contato' + (u.online ? ' online' : '');
    statusEl.textContent = u.online ? 'Online' : 'Offline';
    info.appendChild(nomeEl);
    info.appendChild(statusEl);

    const btnChat = document.createElement('button');
    btnChat.className = 'botao-conversar';
    btnChat.textContent = 'Conversar';
    btnChat.addEventListener('click', e => {
      e.stopPropagation();
      trocarTab('chat');
      abrirConversa(u.name);
    });

    item.appendChild(av);
    item.appendChild(info);
    item.appendChild(btnChat);
    item.addEventListener('click', () => {
      trocarTab('chat');
      abrirConversa(u.name);
    });
    listaEl.appendChild(item);
  });
}

// ===== Abrir conversa =====
function abrirConversa(nome) {
  activeChat = nome;
  unread[nome] = 0;

  convListPanel.classList.add('oculto');
  chatArea.classList.add('expandido');
  chatVazio.style.display = 'none';
  chatContent.style.display = 'flex';
  btnVoltarHeader.classList.add('visivel');

  preencherAvatar(parceiroAvatar, nome, 40);
  parceiroNome.textContent = nome;
  atualizarChatHeader();

  mensagensDiv.innerHTML = '';
  if (historicoCache[nome]) {
    historicoCache[nome].forEach(msg => adicionarMensagem(msg));
  } else {
    socket.emit('carregar_historico', nome);
  }

  renderizarConversas();
  inputMensagem.focus();
}

function atualizarChatHeader() {
  if (!activeChat) return;
  const user = allUsers.find(u => u.name === activeChat);
  const online = user?.online || false;
  parceiroStatus.className = online ? 'online' : '';
  parceiroStatus.textContent = online ? 'Online' : 'Offline';
}

// ===== Voltar (header) =====
btnVoltarHeader.addEventListener('click', () => {
  activeChat = null;
  convListPanel.classList.remove('oculto');
  chatArea.classList.remove('expandido');
  chatContent.style.display = 'none';
  chatVazio.style.display = 'flex';
  btnVoltarHeader.classList.remove('visivel');
  renderizarConversas();
});

// ===== Histórico =====
socket.on('historico', ({ com, msgs }) => {
  historicoCache[com] = msgs;
  if (activeChat === com) {
    mensagensDiv.innerHTML = '';
    msgs.forEach(msg => adicionarMensagem(msg));
  }
});

// ===== Mensagens =====
function adicionarMensagem(msg) {
  const isMinha = msg.de === meuNome;
  const wrapper = document.createElement('div');
  wrapper.className = 'linha-mensagem ' + (isMinha ? 'mensagem-minha' : 'mensagem-recebida');

  const bubble = document.createElement('div');
  bubble.className = 'balao-mensagem';
  bubble.textContent = msg.texto;

  const hora = document.createElement('span');
  hora.className = 'hora-mensagem';
  hora.textContent = msg.hora;

  wrapper.appendChild(bubble);
  wrapper.appendChild(hora);
  mensagensDiv.appendChild(wrapper);
  mensagensDiv.scrollTop = mensagensDiv.scrollHeight;
}

socket.on('mensagem_privada', (msg) => {
  const convKey = msg.de === meuNome ? msg.para : msg.de;

  if (!historicoCache[convKey]) historicoCache[convKey] = [];
  historicoCache[convKey].push(msg);

  // Atualizar lista de conversas ativas
  const idx = conversasAtivas.findIndex(c => c.com === convKey);
  const entry = { com: convKey, ultimaMensagem: msg.texto, hora: msg.hora, ts: msg.ts };
  if (idx >= 0) {
    conversasAtivas.splice(idx, 1);
  }
  conversasAtivas.unshift(entry);

  if (activeChat === convKey) {
    adicionarMensagem(msg);
  } else if (msg.de !== meuNome) {
    unread[msg.de] = (unread[msg.de] || 0) + 1;
  }

  renderizarConversas();
});

// ===== Enviar =====
function enviar() {
  const texto = inputMensagem.value.trim();
  if (!texto || !activeChat) return;
  socket.emit('mensagem_privada', { para: activeChat, texto });
  inputMensagem.value = '';
  inputMensagem.focus();
}

btnEnviar.addEventListener('click', enviar);
inputMensagem.addEventListener('keydown', e => { if (e.key === 'Enter') enviar(); });

// ===== Apagar conversa =====
let targetDeleteUser = null;

function abrirModalApagar(nome) {
  targetDeleteUser = nome;
  modalApagar.hidden = false;
}

function fecharModal() {
  modalApagar.hidden = true;
  targetDeleteUser = null;
}

btnApagar.addEventListener('click', () => abrirModalApagar(activeChat));
modalOverlay.addEventListener('click', fecharModal);
btnCancelarApagar.addEventListener('click', fecharModal);

btnConfirmarApagar.addEventListener('click', () => {
  if (!targetDeleteUser) return;
  socket.emit('apagar_conversa', targetDeleteUser);
  fecharModal();
});

socket.on('conversa_apagada', ({ com }) => {
  delete historicoCache[com];
  conversasAtivas = conversasAtivas.filter(c => c.com !== com);
  renderizarConversas();
  if (activeChat === com) {
    mensagensDiv.innerHTML = '';
  }
});

// ===== Helpers =====
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===== IA Sender =====
const iaInputTitulo   = document.getElementById('campo-titulo-resumo');
const iaInputConteudo = document.getElementById('campo-conteudo-resumo');
const btnEnviarResumo = document.getElementById('botao-enviar-resumo');
const iaFeedback      = document.getElementById('feedback-envio');

function enviarResumo() {
  const titulo   = iaInputTitulo.value.trim();
  const conteudo = iaInputConteudo.value.trim();
  if (!titulo || !conteudo) return;
  btnEnviarResumo.disabled = true;
  socket.emit('enviar_resumo', { titulo, conteudo });
}

btnEnviarResumo.addEventListener('click', enviarResumo);

socket.on('resumo_enviado', () => {
  iaInputTitulo.value   = '';
  iaInputConteudo.value = '';
  btnEnviarResumo.disabled = false;
  iaFeedback.classList.add('visivel');
  setTimeout(() => iaFeedback.classList.remove('visivel'), 3000);
});

// ===== IA Receiver (advogados) =====

function rotuloDia(ts) {
  const d = new Date(ts);
  const hoje = new Date();
  const ontem = new Date(); ontem.setDate(hoje.getDate() - 1);
  const mesmoDia = (a, b) =>
    a.getDate() === b.getDate() &&
    a.getMonth() === b.getMonth() &&
    a.getFullYear() === b.getFullYear();
  if (mesmoDia(d, hoje)) return 'HOJE';
  if (mesmoDia(d, ontem)) return 'ONTEM';
  return d.toLocaleDateString('pt-BR');
}

function chaveData(ts) {
  return new Date(ts).toLocaleDateString('pt-BR');
}

function criarCardResumo(resumo) {
  const card = document.createElement('div');
  card.className = 'cartao-resumo';
  card.innerHTML = `
    <div class="topo-cartao-resumo">
      <span class="titulo-cartao-resumo">${escapeHtml(resumo.titulo)}</span>
      <span class="hora-cartao-resumo">${escapeHtml(resumo.hora)}</span>
    </div>
    <div class="corpo-cartao-resumo">${escapeHtml(resumo.conteudo)}</div>
    <div class="rodape-cartao-resumo">Enviado por: ${escapeHtml(resumo.de)}</div>
  `;
  return card;
}

function criarSecaoDia(rotulo, chave) {
  const secao = document.createElement('div');
  secao.className = 'grupo-por-dia';
  secao.dataset.chave = chave;

  const header = document.createElement('div');
  header.className = 'grupo-dia-cabecalho';
  header.innerHTML = `
    <span class="grupo-dia-data">${escapeHtml(rotulo)}</span>
    <span class="grupo-dia-seta">▾</span>
  `;
  header.addEventListener('click', () => {
    const min = secao.classList.toggle('minimizado');
    header.querySelector('.grupo-dia-seta').textContent = min ? '▸' : '▾';
  });

  const lista = document.createElement('div');
  lista.className = 'grupo-dia-lista';

  secao.appendChild(header);
  secao.appendChild(lista);
  return secao;
}

function renderResumos(lista) {
  const iaLista = document.getElementById('lista-resumos');
  const iaEmpty = document.getElementById('estado-vazio');
  iaLista.innerHTML = '';

  if (!lista || lista.length === 0) {
    if (iaEmpty) iaEmpty.style.display = '';
    return;
  }
  if (iaEmpty) iaEmpty.style.display = 'none';

  // Agrupa por data (chave dd/mm/yyyy)
  const grupos = {};
  lista.forEach(r => {
    const chave = chaveData(r.ts);
    if (!grupos[chave]) grupos[chave] = { rotulo: rotuloDia(r.ts), itens: [] };
    grupos[chave].itens.push(r);
  });

  // Ordena grupos do mais recente para o mais antigo
  Object.keys(grupos)
    .sort((a, b) => {
      const p = s => { const [d,m,y] = s.split('/'); return new Date(y, m-1, d); };
      return p(b) - p(a);
    })
    .forEach(chave => {
      const g = grupos[chave];
      const secao = criarSecaoDia(g.rotulo, chave);
      const listaDia = secao.querySelector('.grupo-dia-lista');
      g.itens
        .sort((a, b) => b.ts - a.ts)
        .forEach(r => listaDia.appendChild(criarCardResumo(r)));
      iaLista.appendChild(secao);
    });
}

socket.on('lista_resumos', renderResumos);

socket.on('novo_resumo', (resumo) => {
  const iaEmpty = document.getElementById('estado-vazio');
  const iaLista = document.getElementById('lista-resumos');
  if (iaEmpty) iaEmpty.style.display = 'none';

  const chave = chaveData(resumo.ts);
  let secao = iaLista.querySelector(`.grupo-por-dia[data-chave="${CSS.escape(chave)}"]`);
  if (!secao) {
    secao = criarSecaoDia(rotuloDia(resumo.ts), chave);
    iaLista.insertBefore(secao, iaLista.firstChild);
  }
  const listaDia = secao.querySelector('.grupo-dia-lista');
  listaDia.insertBefore(criarCardResumo(resumo), listaDia.firstChild);
  // Re-expande a seção caso esteja minimizada
  if (secao.classList.contains('minimizado')) {
    secao.classList.remove('minimizado');
    secao.querySelector('.grupo-dia-seta').textContent = '▾';
  }
});

// ===== Reconexão via token (tratada no ws.onopen do wrapper) =====
socket.on('connect', () => {
  // Sem token: nova conexão limpa — nada a fazer aqui
});

socket.on('reconectar_erro', () => {
  localStorage.removeItem('luma_session');
  meuNome = null; activeChat = null;
  allUsers = []; conversasAtivas = []; unread = {}; historicoCache = {};
  appEl.style.display = 'none';
  telaEntrada.style.display = 'flex';
});
