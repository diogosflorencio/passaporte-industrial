/* Painel de análises - API Passaporte Industrial */

const CONFIG = {
    apiBase: 'https://api-passaporteindustrial.findes.org.br',
    storage: {
        token: 'token',
        refreshToken: 'refresh_token',
        sessionToken: 'session_token',
        usuario: 'usuario_nome'
    },
    renovarAntesMs: 4 * 60 * 1000,
    periodoMaximo: {
        vencimentoInicio: '2000-01-01T00:00:00.000Z',
        vencimentoFim: '2099-12-31T23:59:59.000Z',
        emissaoInicio: '2000-01-01T00:00:00.000Z',
        emissaoFim: '2099-12-31T23:59:59.000Z'
    }
};

let listaContratos = [];
let catalogoTreinamentos = [];
let timerRenovacao = null;
let viewAtiva = 'treinamentos';
let dadosViewAtual = [];
let colaboradoresCache = [];
let colaboradorDossieSelecionado = null;

const state = {
    treinamentos: [],
    porTreinamento: [],
    catalogo: [],
    funcionarios: [],
    passaportes: [],
    documentos: []
};

const tabelaStore = {};

// ─── Auth & API ───────────────────────────────────────────────

function getToken() { return localStorage.getItem(CONFIG.storage.token) || ''; }
function getRefreshToken() { return localStorage.getItem(CONFIG.storage.refreshToken) || ''; }
function getSessionToken() { return localStorage.getItem(CONFIG.storage.sessionToken) || ''; }

function salvarSessao(payload) {
    localStorage.setItem(CONFIG.storage.token, payload.token || '');
    localStorage.setItem(CONFIG.storage.refreshToken, payload.refreshToken || payload.refresh_token || '');
    localStorage.setItem(CONFIG.storage.sessionToken, payload.sessionToken || payload.session_token || '');
    if (payload.usuario) {
        const nome = payload.usuario.nome || payload.usuario.login || payload.usuario.email || 'Usuário';
        localStorage.setItem(CONFIG.storage.usuario, nome);
    }
}

function limparSessao() {
    Object.values(CONFIG.storage).forEach((k) => localStorage.removeItem(k));
    if (timerRenovacao) clearInterval(timerRenovacao);
    timerRenovacao = null;
}

function estaAutenticado() {
    return Boolean(getToken() && getSessionToken());
}

function extrairPayload(json) {
    if (json && typeof json === 'object' && 'data' in json && json.data !== undefined) return json.data;
    return json;
}

function montarQuery(params) {
    return Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && String(v).trim() !== '')
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
}

function cabecalhosAuth(usarRefresh = false) {
    const headers = {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Cache-Control': 'no-cache',
        'Session-Token': getSessionToken()
    };
    const token = usarRefresh ? getRefreshToken() : getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
}

async function renovarToken() {
    const response = await fetch(`${CONFIG.apiBase}/autenticacao-usuario/renovar-token`, {
        method: 'POST',
        headers: cabecalhosAuth(true),
        body: JSON.stringify({})
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error('Sessão expirada. Faça login novamente.');
    const payload = extrairPayload(json);
    salvarSessao({ token: payload.token, refreshToken: payload.refreshToken, sessionToken: payload.sessionToken });
    return payload.token;
}

async function apiFetch(caminho, opcoes = {}) {
    const url = caminho.startsWith('http') ? caminho : `${CONFIG.apiBase}${caminho}`;
    const fazer = (refresh) => fetch(url, { ...opcoes, headers: { ...cabecalhosAuth(refresh), ...(opcoes.headers || {}) } });
    let response = await fazer(false);
    if (response.status === 401 && !caminho.includes('renovar-token')) {
        await renovarToken();
        response = await fazer(false);
    }
    const json = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, dados: extrairPayload(json), bruto: json };
}

async function apiGet(caminho, params = {}) {
    const qs = montarQuery(params);
    const path = qs ? `${caminho}?${qs}` : caminho;
    return apiFetch(path);
}

async function fazerLogin(login, senha) {
    const response = await fetch(`${CONFIG.apiBase}/autenticacao-usuario/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ login, senha })
    });
    const json = await response.json().catch(() => ({}));
    const payload = extrairPayload(json);
    if (!response.ok) {
        const msg = payload?.errors?.join?.(' ') || payload || json?.message || 'Credenciais inválidas.';
        throw new Error(typeof msg === 'string' ? msg : 'Não foi possível entrar.');
    }
    if (!payload.token || !payload.sessionToken) throw new Error('Resposta de login incompleta.');
    salvarSessao(payload);
    agendarRenovacaoToken();
    return payload;
}

function agendarRenovacaoToken() {
    if (timerRenovacao) clearInterval(timerRenovacao);
    timerRenovacao = setInterval(async () => {
        if (!estaAutenticado()) return;
        try {
            await renovarToken();
            atualizarStatusSessao('Sessão renovada');
        } catch {
            encerrarSessao('Sessão expirada. Entre novamente.');
        }
    }, CONFIG.renovarAntesMs);
}

// ─── UI helpers ───────────────────────────────────────────────

function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function formatarData(val) {
    if (!val) return '-';
    const d = val instanceof Date ? val : new Date(val);
    return Number.isNaN(d.getTime()) ? '-' : d.toLocaleDateString('pt-BR');
}

function formatarCpf(cpf) {
    if (!cpf) return '-';
    const n = String(cpf).replace(/\D/g, '');
    if (n.length !== 11) return cpf;
    return n.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
}

function calcularStatus(dataVencimento) {
    if (!dataVencimento) return { texto: '-', classe: '' };
    const venc = new Date(dataVencimento);
    const dias = Math.ceil((venc - new Date()) / (86400000));
    if (dias < 0) return { texto: 'Vencido', classe: 'status-vencido' };
    if (dias <= 30) return { texto: `Vence em ${dias}d`, classe: 'status-proximo' };
    return { texto: 'Válido', classe: 'status-valido' };
}

function formatarParaInputDatetimeLocal(data) {
    const copia = new Date(data.getTime());
    copia.setMinutes(copia.getMinutes() - copia.getTimezoneOffset());
    return copia.toISOString().slice(0, 16);
}

function obterFiltrosBase() {
    const contratoId = document.getElementById('contrato').value;
    const contratanteId = document.getElementById('empresaContratante').value;
    const contratadaId = document.getElementById('empresaContratada').value;
    const dataInicio = document.getElementById('dataInicio').value;
    const dataFim = document.getElementById('dataFim').value;
    return {
        contratoId,
        contratanteId,
        contratadaId,
        dataInicio,
        dataFim,
        take: document.getElementById('take').value || '5000',
        page: document.getElementById('page').value || '1',
        busca: (document.getElementById('buscaColaborador')?.value || '').trim().toLowerCase(),
        treinamento: document.getElementById('filtroTreinamento')?.value || ''
    };
}

function mostrarStatus(msg, tipo = 'info') {
    const el = document.getElementById('painelStatus');
    el.textContent = msg;
    el.className = `painel-status ${tipo}`;
    el.classList.remove('oculto');
}

function ocultarStatus() {
    document.getElementById('painelStatus').classList.add('oculto');
}

function renderResumo(containerId, cards) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = cards
        .map((c) => `<div class="card-resumo"><strong>${escapeHtml(c.valor)}</strong><span>${escapeHtml(c.rotulo)}</span></div>`)
        .join('');
}

function parseApiLista(dados, bruto) {
    if (Array.isArray(dados)) return { lista: dados, quantidade: dados.length, message: bruto?.message };
    if (dados?.dados && Array.isArray(dados.dados)) {
        return { lista: dados.dados, quantidade: dados.quantidade ?? dados.dados.length, message: bruto?.message };
    }
    if (bruto?.data?.dados && Array.isArray(bruto.data.dados)) {
        return { lista: bruto.data.dados, quantidade: bruto.data.quantidade ?? bruto.data.dados.length, message: bruto.message };
    }
    return { lista: [], quantidade: 0, message: bruto?.message };
}

function textoBuscaLinha(row) {
    const raw = row._raw || row;
    return Object.values(raw)
        .map((v) => (v == null ? '' : String(v)))
        .join(' ')
        .toLowerCase();
}

function aplicarFiltrosTabela(store) {
    let linhas = store.completo;
    const q = (store.filtroTexto || '').trim().toLowerCase();
    if (q) linhas = linhas.filter((row) => textoBuscaLinha(row).includes(q));
    if (store.filtroCustom) linhas = linhas.filter(store.filtroCustom);
    else if (store.filtroStatus) {
        linhas = linhas.filter((row) => {
            const st = calcularStatus(row._raw?.dataVencimento);
            if (store.filtroStatus === 'Válido') return st.texto === 'Válido';
            if (store.filtroStatus === 'Vencido') return st.texto === 'Vencido';
            return st.classe === 'status-proximo';
        });
    }
    store.filtrado = linhas;
    return linhas;
}

function desenharCorpoTabela(containerId, colunas, linhas, opcoes) {
    const el = document.getElementById(containerId);
    if (!linhas.length) {
        el.innerHTML = '<p class="sem-dados">Nenhum registro encontrado.</p>';
        el.classList.remove('com-toolbar');
        return;
    }
    el.classList.add('com-toolbar');
    const thead = colunas.map((c) => `<th>${escapeHtml(c.titulo)}</th>`).join('');
    const tbody = linhas
        .map((row, idx) => {
            const cls = [
                opcoes.linhaClicavel ? 'linha-clicavel' : '',
                opcoes.linhaSelecionada === row._idxOriginal ? 'linha-selecionada' : ''
            ]
                .filter(Boolean)
                .join(' ');
            const cells = colunas.map((c) => `<td>${row[c.chave] ?? '-'}</td>`).join('');
            return `<tr class="${cls}" data-idx="${row._idxOriginal ?? idx}">${cells}</tr>`;
        })
        .join('');
    el.innerHTML = `<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>`;
    if (opcoes.onLinhaClick) {
        el.querySelectorAll('tr.linha-clicavel').forEach((tr) => {
            tr.addEventListener('click', () => opcoes.onLinhaClick(+tr.dataset.idx));
        });
    }
}

function atualizarContadorTabela(containerId) {
    const store = tabelaStore[containerId];
    const el = document.querySelector(`[data-contador="${containerId}"]`);
    if (!store || !el) return;
    el.textContent = `${store.filtrado.length} de ${store.completo.length} registros`;
}

function renderizarTabelaFiltravel(containerId) {
    const store = tabelaStore[containerId];
    if (!store) return;
    const linhas = aplicarFiltrosTabela(store).map((row, i) => ({ ...row, _idxOriginal: row._idxOriginal ?? i }));
    desenharCorpoTabela(containerId, store.colunas, linhas, store.opcoes);
    atualizarContadorTabela(containerId);
    dadosViewAtual = store.filtrado;
}

function criarTabelaFiltravel(containerId, colunas, linhasCompletas, opcoes = {}) {
    const wrap = document.getElementById(containerId);
    if (!wrap) return;

    const linhas = linhasCompletas.map((row, i) => ({
        ...row,
        _idxOriginal: i,
        _statusFiltro: row._raw?.dataVencimento ? calcularStatus(row._raw.dataVencimento).texto : ''
    }));

    tabelaStore[containerId] = {
        colunas,
        completo: linhas,
        filtrado: linhas,
        filtroTexto: '',
        filtroStatus: '',
        opcoes
    };

    const toolbarId = `toolbar-${containerId}`;
    let toolbar = document.getElementById(toolbarId);
    if (!toolbar) {
        toolbar = document.createElement('div');
        toolbar.id = toolbarId;
        toolbar.className = 'toolbar-tabela';
        toolbar.dataset.toolbarFor = containerId;
        wrap.parentNode.insertBefore(toolbar, wrap);
    }

    const filtrosStatus = opcoes.filtroStatus
        ? `<select data-filtro-status="${containerId}">
            <option value="">Status: todos</option>
            <option value="Válido">Válido</option>
            <option value="Vencido">Vencido</option>
            <option value="Próximo">Vence em ≤30 dias</option>
           </select>`
        : '';

    toolbar.innerHTML = `
        <input type="search" placeholder="Pesquisar na tabela..." data-busca="${containerId}" value="">
        ${filtrosStatus}
        <span class="contador-tabela" data-contador="${containerId}"></span>
    `;

    const inputBusca = toolbar.querySelector(`[data-busca="${containerId}"]`);
    inputBusca.oninput = () => {
        tabelaStore[containerId].filtroTexto = inputBusca.value;
        renderizarTabelaFiltravel(containerId);
    };

    const selectStatus = toolbar.querySelector(`[data-filtro-status="${containerId}"]`);
    if (selectStatus) {
        selectStatus.onchange = () => {
            tabelaStore[containerId].filtroCustom = null;
            tabelaStore[containerId].filtroStatus = selectStatus.value;
            renderizarTabelaFiltravel(containerId);
        };
    }

    renderizarTabelaFiltravel(containerId);
}

function valorExportacao(row, chave) {
    const raw = row._raw || {};
    const simNao = (v) => (v === true ? 'Sim' : v === false ? 'Não' : '');
    const mapa = {
        id: raw.id,
        funcionario: raw.funcionario || raw.nomeFuncionario || raw.nome,
        nome: raw.nome || raw.funcionario,
        treinamento: raw.treinamento || raw.nomeTreinamento || raw.nome,
        cpf: formatarCpf(raw.cpf || raw.cpfFuncionario),
        contrato: raw.numeroContrato,
        contratante: raw.empresaContratante || raw.contratante,
        contratada: raw.empresaContratada || raw.contratada,
        vencimento: formatarData(raw.dataVencimento),
        emissao: formatarData(raw.dataEmissao),
        validade: formatarData(raw.dataValidade || raw.dataVencimento),
        statusTexto: calcularStatus(raw.dataVencimento).texto,
        statusTreinamento: calcularStatus(raw.dataVencimento).texto,
        statusDoc: raw.status === true ? 'Ativo' : raw.status === false ? 'Inativo' : '',
        cargo: raw.cargo,
        orgao: raw.orgao,
        funcao: raw.funcao || raw.nomeFuncao || raw.cargo,
        localizador: raw.localizador,
        tipo: raw.tipoExame || raw.tipoDocumento,
        validadeEmDias: raw.validadeEmDias,
        liberacao: simNao(raw.liberacao),
        statusCatalogo: raw.status === true ? 'Ativo' : raw.status === false ? 'Inativo' : '',
        documentoInterno: simNao(raw.documentoInterno),
        criador: raw.nomeUsuarioCriador,
        inicioContrato: formatarData(raw.dataInicioContrato),
        fimContrato: formatarData(raw.dataFimContrato)
    };
    if (mapa[chave] != null && mapa[chave] !== '') return String(mapa[chave]);
    const v = row[chave];
    return v != null ? String(v).replace(/<[^>]+>/g, '') : '';
}

function exportarPlanilha(nomeArquivo, colunas, linhas) {
    if (!linhas.length) {
        alert('Nada para exportar.');
        return;
    }
    const header = colunas.map((c) => c.titulo);
    const rows = linhas.map((row) =>
        colunas.map((c) => valorExportacao(row, c.exportar ?? c.chave))
    );
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Dados');
    XLSX.writeFile(wb, nomeArquivo.endsWith('.xlsx') ? nomeArquivo : `${nomeArquivo}.xlsx`);
}

function quantidadeTotal(parsed, lista) {
    if (parsed?.quantidade != null) return parsed.quantidade;
    return lista.length;
}

// ─── Filtros compartilhados ───────────────────────────────────

async function carregarContratos() {
    const select = document.getElementById('contrato');
    select.disabled = true;
    select.innerHTML = '<option value="">Carregando...</option>';
    const { ok, dados } = await apiFetch('/empresas/contratos-para-selecao');
    if (!ok || !Array.isArray(dados)) {
        select.innerHTML = '<option value="">Erro ao carregar</option>';
        return;
    }
    listaContratos = dados.slice().sort((a, b) =>
        String(a.empresaContratante || '').localeCompare(String(b.empresaContratante || ''))
    );
    select.innerHTML = '<option value="">Todos</option>';
    listaContratos.forEach((item) => {
        const opt = document.createElement('option');
        opt.value = String(item.contratoId);
        opt.textContent = `${item.numeroContrato || item.contratoId} - ${item.empresaContratante || ''}`.trim();
        select.appendChild(opt);
    });
    select.disabled = false;
    await preencherContratantes();
}

async function preencherContratantes() {
    const select = document.getElementById('empresaContratante');
    const mapa = new Map();
    listaContratos.forEach((c) => {
        if (c.empresaContratanteId && c.empresaContratante) {
            mapa.set(String(c.empresaContratanteId), c.empresaContratante);
        }
    });
    select.innerHTML = '<option value="">Todas</option>';
    [...mapa.entries()].sort((a, b) => a[1].localeCompare(b[1])).forEach(([id, nome]) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = nome;
        select.appendChild(opt);
    });
    select.disabled = false;
    await carregarContratadas(select.value);
}

async function carregarContratadas(contratanteId) {
    const select = document.getElementById('empresaContratada');
    select.innerHTML = '<option value="">Todas</option>';
    if (!contratanteId) return;
    select.disabled = true;
    const { ok, dados } = await apiFetch(`/empresas/contratada-por-contratante/${contratanteId}`);
    if (ok && Array.isArray(dados)) {
        dados
            .sort((a, b) => String(a.nome || a.razaoSocial || '').localeCompare(String(b.nome || b.razaoSocial || '')))
            .forEach((e) => {
                const opt = document.createElement('option');
                opt.value = String(e.id);
                opt.textContent = e.nome || e.razaoSocial || `Empresa ${e.id}`;
                select.appendChild(opt);
            });
    }
    select.disabled = false;
}

function aoMudarContrato() {
    const contratoId = document.getElementById('contrato').value;
    const contrato = listaContratos.find((c) => String(c.contratoId) === contratoId);
    if (contrato?.empresaContratanteId) {
        document.getElementById('empresaContratante').value = String(contrato.empresaContratanteId);
        carregarContratadas(contrato.empresaContratanteId);
    }
}

async function carregarCatalogoTreinamentosFiltro() {
    const select = document.getElementById('filtroTreinamento');
    const { ok, dados, bruto } = await apiFetch('/treinamentos');
    const { lista } = parseApiLista(dados, bruto);
    if (!ok) return;
    catalogoTreinamentos = lista;
    select.innerHTML = '<option value="">Todos</option>';
    lista
        .map((t) => t.nome || t.descricao || t.treinamento)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b))
        .forEach((nome) => {
            const opt = document.createElement('option');
            opt.value = nome;
            opt.textContent = nome;
            select.appendChild(opt);
        });
}

function normalizarTexto(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function treinamentoCombina(nomeRelatorio, filtro) {
    const a = normalizarTexto(nomeRelatorio);
    const b = normalizarTexto(filtro);
    if (!a || !b) return false;
    if (a === b || a.includes(b) || b.includes(a)) return true;
    const semPrefixo = (t) => t.replace(/^([a-z0-9\s]+-\s*)+/i, '').trim();
    const ap = semPrefixo(a);
    const bp = semPrefixo(b);
    return ap === bp || ap.includes(bp) || bp.includes(ap);
}

function contratoIdPorNumero(numero) {
    if (!numero) return '';
    const c = listaContratos.find((x) => String(x.numeroContrato) === String(numero));
    return c ? String(c.contratoId) : '';
}

function atualizarSelectTreinamentosRelatorio(nomes) {
    const select = document.getElementById('filtroTreinamento');
    if (!select) return;
    const atual = select.value;
    const unicos = [...new Set(nomes.filter(Boolean))].sort((a, b) => a.localeCompare(b));
    select.innerHTML = '<option value="">Selecione um treinamento</option>';
    unicos.forEach((nome) => {
        const opt = document.createElement('option');
        opt.value = nome;
        opt.textContent = nome;
        select.appendChild(opt);
    });
    if (atual && unicos.some((n) => treinamentoCombina(n, atual) || treinamentoCombina(atual, n))) {
        select.value = unicos.find((n) => treinamentoCombina(n, atual)) || atual;
    }
}

function atualizarFiltrosVisiveis() {
    document.querySelectorAll('.filtro-view').forEach((el) => el.classList.add('oculto'));
    document.querySelectorAll('.filtro-data').forEach((el) => {
        el.classList.toggle('oculto', viewAtiva !== 'treinamentos');
    });
    if (viewAtiva === 'porTreinamento') {
        document.querySelectorAll('.filtro-view-porTreinamento').forEach((e) => e.classList.remove('oculto'));
    }
    if (viewAtiva === 'funcionarios' || viewAtiva === 'dossies') {
        document.querySelectorAll('.filtro-view-funcionarios, .filtro-view-dossies').forEach((e) => e.classList.remove('oculto'));
    }
}

function trocarView(view) {
    viewAtiva = view;
    document.querySelectorAll('.aba').forEach((b) => b.classList.toggle('ativa', b.dataset.view === view));
    document.querySelectorAll('.view-panel').forEach((p) => p.classList.toggle('ativa', p.dataset.view === view));
    atualizarFiltrosVisiveis();
    ocultarStatus();
}

// ─── Consultas por view ───────────────────────────────────────

function linhasTreinamentoRelatorio(itens) {
    return itens.map((item) => {
        const st = calcularStatus(item.dataVencimento);
        return {
            funcionario: escapeHtml(item.funcionario),
            cpf: formatarCpf(item.cpf),
            treinamento: escapeHtml(item.treinamento),
            contratante: escapeHtml(item.empresaContratante),
            contratada: escapeHtml(item.empresaContratada),
            contrato: escapeHtml(item.numeroContrato),
            emissao: formatarData(item.dataEmissao),
            vencimento: formatarData(item.dataVencimento),
            status: `<span class="${st.classe}">${st.texto}</span>`,
            _raw: item
        };
    });
}

const COL_TREINAMENTOS = [
    { titulo: 'Funcionário', chave: 'funcionario', exportar: 'funcionario' },
    { titulo: 'CPF', chave: 'cpf', exportar: 'cpf' },
    { titulo: 'Treinamento', chave: 'treinamento', exportar: 'treinamento' },
    { titulo: 'Contratante', chave: 'contratante', exportar: 'contratante' },
    { titulo: 'Contratada', chave: 'contratada', exportar: 'contratada' },
    { titulo: 'Contrato', chave: 'contrato', exportar: 'contrato' },
    { titulo: 'Emissão', chave: 'emissao', exportar: 'emissao' },
    { titulo: 'Vencimento', chave: 'vencimento', exportar: 'vencimento' },
    { titulo: 'Status', chave: 'status', exportar: 'statusTreinamento' }
];

async function buscarDadosTreinamentosApi(opcoes = {}) {
    const f = obterFiltrosBase();
    const params = { take: f.take, page: f.page };

    if (opcoes.periodoMaximo) {
        params.dataInicioVencimento = CONFIG.periodoMaximo.vencimentoInicio;
        params.dataFimVencimento = CONFIG.periodoMaximo.vencimentoFim;
    } else {
        if (f.dataInicio) params.dataInicioVencimento = f.dataInicio + ':00.000Z';
        if (f.dataFim) params.dataFimVencimento = f.dataFim + ':00.000Z';
    }

    if (f.contratoId) params.contratoId = f.contratoId;
    if (f.contratanteId) params.empresaContratanteId = f.contratanteId;
    if (f.contratadaId) params.empresaContratadaId = f.contratadaId;

    const path = `/treinamentos-funcionario/relatorio?${montarQuery(params)}`;
    document.getElementById('urlDebug').textContent = CONFIG.apiBase + path;

    const { ok, dados, bruto } = await apiFetch(path);
    if (!ok) throw new Error(extrairPayload(bruto)?.errors?.join?.(' ') || 'Erro ao buscar treinamentos.');

    const parsed = parseApiLista(dados, bruto);
    const linhas = linhasTreinamentoRelatorio(parsed.lista);
    return { parsed, lista: parsed.lista, linhas };
}

async function consultarTreinamentos() {
    const { parsed, lista, linhas } = await buscarDadosTreinamentosApi();
    state.treinamentos = linhas;

    const vencidos = lista.filter((i) => calcularStatus(i.dataVencimento).texto === 'Vencido').length;
    const proximos = lista.filter((i) => calcularStatus(i.dataVencimento).classe === 'status-proximo').length;

    renderResumo('resumoTreinamentos', [
        { valor: quantidadeTotal(parsed, lista), rotulo: 'Total na API' },
        { valor: linhas.length, rotulo: 'Retornados' },
        { valor: vencidos, rotulo: 'Vencidos' },
        { valor: proximos, rotulo: 'Vence em ≤30 dias' }
    ]);
    criarTabelaFiltravel('tabelaTreinamentos', COL_TREINAMENTOS, linhas, { filtroStatus: true });
    return linhas;
}

async function consultarPorTreinamento() {
    const f = obterFiltrosBase();
    const { parsed, lista, linhas: todas } = await buscarDadosTreinamentosApi({ periodoMaximo: true });

    atualizarSelectTreinamentosRelatorio(lista.map((i) => i.treinamento));

    if (!todas.length) {
        mostrarStatus('A API não retornou registros no período amplo. Verifique contrato/empresa nos filtros.', 'info');
        criarTabelaFiltravel('tabelaPorTreinamento', COL_TREINAMENTOS, [], { filtroStatus: true });
        return [];
    }

    if (!f.treinamento) {
        state.porTreinamento = todas;
        renderResumo('resumoPorTreinamento', [
            { valor: quantidadeTotal(parsed, lista), rotulo: 'Total na API' },
            { valor: todas.length, rotulo: 'Carregados (todos)' }
        ]);
        criarTabelaFiltravel('tabelaPorTreinamento', COL_TREINAMENTOS, todas, { filtroStatus: true });
        mostrarStatus('Selecione um treinamento no filtro (nomes do relatório) e clique em Consultar para filtrar.', 'info');
        return todas;
    }

    const filtradas = todas.filter((l) => treinamentoCombina(l._raw?.treinamento, f.treinamento));
    state.porTreinamento = filtradas;

    renderResumo('resumoPorTreinamento', [
        { valor: f.treinamento, rotulo: 'Treinamento' },
        { valor: filtradas.length, rotulo: 'Registros' },
        { valor: quantidadeTotal(parsed, lista), rotulo: 'Total API (período amplo)' }
    ]);

    if (!filtradas.length) {
        mostrarStatus(
            `Nenhum registro para "${f.treinamento}". Foram carregados ${todas.length} no total - escolha um nome da lista do filtro (vindos do relatório).`,
            'info'
        );
    }

    criarTabelaFiltravel('tabelaPorTreinamento', COL_TREINAMENTOS, filtradas, { filtroStatus: true });
    return filtradas;
}

async function consultarCatalogo() {
    const { ok, dados, bruto } = await apiFetch('/treinamentos');
    if (!ok) throw new Error('Erro ao carregar catálogo de treinamentos.');
    const parsed = parseApiLista(dados, bruto);
    const lista = parsed.lista;
    const linhas = lista.map((t) => ({
        id: t.id,
        nome: escapeHtml(t.nome || '-'),
        validade: t.validadeEmDias != null ? `${t.validadeEmDias} dias` : '-',
        liberacao: t.liberacao ? 'Sim' : 'Não',
        status: t.status ? 'Ativo' : 'Inativo',
        _raw: t
    }));
    state.catalogo = linhas;
    renderResumo('resumoCatalogo', [{ valor: quantidadeTotal(parsed, lista), rotulo: 'Treinamentos cadastrados' }]);
    criarTabelaFiltravel('tabelaCatalogo', [
        { titulo: 'ID', chave: 'id', exportar: 'id' },
        { titulo: 'Nome', chave: 'nome', exportar: 'nome' },
        { titulo: 'Validade (dias)', chave: 'validade', exportar: 'validadeEmDias' },
        { titulo: 'Liberação', chave: 'liberacao', exportar: 'liberacao' },
        { titulo: 'Status', chave: 'status', exportar: 'statusCatalogo' }
    ], linhas);
    dadosViewAtual = linhas;

    const nomes = lista.map((t) => t.nome).filter(Boolean);
    const select = document.getElementById('filtroTreinamento');
    const atual = select.value;
    select.innerHTML = '<option value="">Todos</option>';
    [...new Set(nomes)].sort().forEach((nome) => {
        const opt = document.createElement('option');
        opt.value = nome;
        opt.textContent = nome;
        select.appendChild(opt);
    });
    if (atual) select.value = atual;
    return linhas;
}

async function buscarFuncionariosApi(f) {
    const base = {
        contratoId: f.contratoId,
        take: f.take,
        page: f.page,
        sortAsc: true,
        sortColumn: 'nome'
    };

    const cpfBusca = f.busca.replace(/\D/g, '');
    if (cpfBusca.length >= 3) base.cpf = cpfBusca;

    const tentativas = [
        { ...base, status: 'true' },
        { ...base },
        { ...base, status: 'false' },
        { ...base, sortColumn: 'id' }
    ];
    let ultimo = { lista: [], parsed: { quantidade: 0 }, ok: false, bruto: null };

    for (const params of tentativas) {
        const path = `/funcionarios?${montarQuery(params)}`;
        document.getElementById('urlDebug').textContent = CONFIG.apiBase + path;
        const res = await apiGet('/funcionarios', params);
        const parsed = parseApiLista(res.dados, res.bruto);
        ultimo = { ...res, parsed, lista: parsed.lista, params };
        if (res.ok && parsed.lista.length) return ultimo;
    }
    return ultimo;
}

function colaboradoresUnicosDeTreinamentos(linhasTreino) {
    const mapa = new Map();
    linhasTreino.forEach((l) => {
        const r = l._raw;
        if (!r?.cpf) return;
        const cpf = String(r.cpf).replace(/\D/g, '');
        if (!mapa.has(cpf)) {
            mapa.set(cpf, {
                id: null,
                nome: r.funcionario,
                cpf: r.cpf,
                cargo: '-',
                orgao: '-',
                localizador: '-',
                status: true,
                numeroContrato: r.numeroContrato,
                contratoId: contratoIdPorNumero(r.numeroContrato),
                empresaContratada: r.empresaContratada,
                _somenteCpf: true
            });
        }
    });
    return [...mapa.values()];
}

function mapearLinhasFuncionarios(lista) {
    return lista.map((item) => ({
        id: item.id,
        nome: escapeHtml(item.nome || item.funcionario || '-'),
        cpf: formatarCpf(item.cpf),
        cargo: escapeHtml(item.cargo || item.funcao || item.nomeFuncao || '-'),
        orgao: escapeHtml(item.orgao || '-'),
        localizador: escapeHtml(item.localizador || '-'),
        status: item.status === false ? 'Inativo' : 'Ativo',
        _raw: item
    }));
}

async function consultarFuncionarios() {
    const f = obterFiltrosBase();
    let lista = [];
    let res = { parsed: { quantidade: 0 }, lista: [] };

    if (f.contratoId) {
        res = await buscarFuncionariosApi(f);
        lista = res.lista;
    }

    if (!lista.length) {
        const { parsed, lista: listaTreino, linhas: treinos } = await buscarDadosTreinamentosApi({ periodoMaximo: true });
        lista = colaboradoresUnicosDeTreinamentos(treinos);
        res = { parsed, lista: listaTreino };
        if (lista.length) {
            mostrarStatus(
                f.contratoId
                    ? 'Lista montada pelo relatório de treinamentos (período amplo), pois /funcionarios veio vazio.'
                    : 'Sem contrato na API de funcionários - colaboradores únicos pelo relatório de treinamentos.',
                'info'
            );
        } else if (!f.contratoId) {
            mostrarStatus('Selecione um contrato ou ajuste empresas nos filtros.', 'info');
            return [];
        }
    }

    if (f.busca && !f.busca.match(/^\d+$/)) {
        lista = lista.filter((item) => {
            const nome = (item.nome || item.funcionario || '').toLowerCase();
            return nome.includes(f.busca);
        });
    }

    const linhas = mapearLinhasFuncionarios(lista);
    state.funcionarios = linhas;
    colaboradoresCache = linhas;

    renderResumo('resumoFuncionarios', [
        { valor: quantidadeTotal(res.parsed, res.lista), rotulo: 'Total API' },
        { valor: linhas.length, rotulo: 'Exibidos' }
    ]);
    criarTabelaFiltravel('tabelaFuncionarios', [
        { titulo: 'Nome', chave: 'nome', exportar: 'funcionario' },
        { titulo: 'CPF', chave: 'cpf', exportar: 'cpf' },
        { titulo: 'Cargo', chave: 'cargo', exportar: 'cargo' },
        { titulo: 'Órgão', chave: 'orgao', exportar: 'orgao' },
        { titulo: 'Localizador', chave: 'localizador', exportar: 'localizador' },
        { titulo: 'Status', chave: 'status' }
    ], linhas);
    return linhas;
}

async function consultarPassaportes() {
    const f = obterFiltrosBase();
    const partes = [
        `take=${f.take}&`,
        `page=${f.page}&`,
        `dataEmissaoInicio=${CONFIG.periodoMaximo.emissaoInicio}&`,
        `dataEmissaoFim=${CONFIG.periodoMaximo.emissaoFim}&`
    ];
    if (f.contratoId) partes.push(`contratoId=${f.contratoId}&`);
    if (f.contratanteId) partes.push(`contratanteId=${f.contratanteId}&`);
    if (f.contratadaId) partes.push(`contratadaId=${f.contratadaId}&`);

    const path = `/passaporte-funcionario/relatorio?${partes.join('')}`;
    document.getElementById('urlDebug').textContent = CONFIG.apiBase + path;

    const { ok, dados, bruto } = await apiFetch(path);
    if (!ok) throw new Error('Erro ao buscar passaportes.');

    const parsed = parseApiLista(dados, bruto);
    const lista = parsed.lista;
    const linhas = lista.map((item) => ({
        funcionario: escapeHtml(item.nomeFuncionario || '-'),
        cpf: formatarCpf(item.cpf),
        contratante: escapeHtml(item.contratante || '-'),
        contratada: escapeHtml(item.contratada || '-'),
        contrato: escapeHtml(item.numeroContrato || '-'),
        emissao: formatarData(item.dataEmissao),
        fimContrato: formatarData(item.dataFimContrato),
        localizador: escapeHtml(item.localizador || '-'),
        criador: escapeHtml(item.nomeUsuarioCriador || '-'),
        _raw: item
    }));

    state.passaportes = linhas;
    renderResumo('resumoPassaportes', [
        { valor: quantidadeTotal(parsed, lista), rotulo: 'Passaportes' },
        { valor: linhas.length, rotulo: 'Retornados' }
    ]);
    criarTabelaFiltravel('tabelaPassaportes', [
        { titulo: 'Funcionário', chave: 'funcionario', exportar: 'funcionario' },
        { titulo: 'CPF', chave: 'cpf', exportar: 'cpf' },
        { titulo: 'Contratante', chave: 'contratante', exportar: 'contratante' },
        { titulo: 'Contratada', chave: 'contratada', exportar: 'contratada' },
        { titulo: 'Contrato', chave: 'contrato', exportar: 'contrato' },
        { titulo: 'Emissão', chave: 'emissao', exportar: 'emissao' },
        { titulo: 'Fim contrato', chave: 'fimContrato', exportar: 'fimContrato' },
        { titulo: 'Localizador', chave: 'localizador', exportar: 'localizador' }
    ], linhas);
    return linhas;
}

async function consultarDocumentos() {
    const f = obterFiltrosBase();
    const params = {
        take: f.take,
        page: f.page,
        sortAsc: true,
        sortColumn: '',
        dataValidadeInicio: CONFIG.periodoMaximo.vencimentoInicio,
        dataValidadeFim: CONFIG.periodoMaximo.vencimentoFim
    };
    if (f.contratoId) params.contratoId = f.contratoId;
    if (f.contratanteId) params.empresaContratanteId = f.contratanteId;
    if (f.contratadaId) params.empresaContratadaId = f.contratadaId;

    const path = `/documentos-funcionario/relatorio?${montarQuery(params)}`;
    document.getElementById('urlDebug').textContent = CONFIG.apiBase + path;

    const { ok, dados, bruto } = await apiFetch(path);
    if (!ok) throw new Error('Erro ao buscar documentos.');

    const parsed = parseApiLista(dados, bruto);
    const lista = parsed.lista;
    const linhas = lista.map((item) => ({
        funcionario: escapeHtml(item.funcionario || '-'),
        cpf: formatarCpf(item.cpfFuncionario || item.cpf),
        tipo: escapeHtml(item.tipoExame || '-'),
        contrato: escapeHtml(item.numeroContrato || '-'),
        emissao: formatarData(item.dataEmissao),
        validade: formatarData(item.dataValidade),
        status: item.status ? 'Ativo' : 'Inativo',
        _raw: item
    }));

    state.documentos = linhas;
    renderResumo('resumoDocumentos', [
        { valor: quantidadeTotal(parsed, lista), rotulo: 'Documentos' },
        { valor: linhas.length, rotulo: 'Retornados' }
    ]);
    criarTabelaFiltravel('tabelaDocumentos', [
        { titulo: 'Funcionário', chave: 'funcionario', exportar: 'funcionario' },
        { titulo: 'CPF', chave: 'cpf', exportar: 'cpf' },
        { titulo: 'Tipo exame', chave: 'tipo', exportar: 'tipo' },
        { titulo: 'Contrato', chave: 'contrato', exportar: 'contrato' },
        { titulo: 'Emissão', chave: 'emissao', exportar: 'emissao' },
        { titulo: 'Validade', chave: 'validade', exportar: 'validade' },
        { titulo: 'Status', chave: 'status', exportar: 'statusDoc' }
    ], linhas);
    return linhas;
}

// ─── Dossiês ──────────────────────────────────────────────────

let dossieListaFiltrada = [];

function renderListaDossies(linhas) {
    const el = document.getElementById('listaDossies');
    const termo = (document.getElementById('buscaDossie')?.value || '').trim().toLowerCase();
    dossieListaFiltrada = termo
        ? linhas.filter((l) => `${l.nome} ${l.cpf} ${l.cargo}`.toLowerCase().includes(termo))
        : linhas;

    if (!dossieListaFiltrada.length) {
        el.innerHTML = '<p class="sem-dados">Nenhum colaborador. Selecione contrato e consulte.</p>';
        return;
    }
    el.innerHTML = dossieListaFiltrada
        .map(
            (l, idx) => `
        <div class="item-dossie ${colaboradorDossieSelecionado === idx ? 'ativo' : ''}" data-idx="${idx}">
            <strong>${l.nome}</strong>
            <small>${l.cpf} · ${l.cargo || l.funcao || ''}</small>
        </div>`
        )
        .join('');
    el.querySelectorAll('.item-dossie').forEach((item) => {
        item.addEventListener('click', () => abrirDossie(+item.dataset.idx));
    });
}

async function resolverFuncionarioId(colaborador, contratoId) {
    if (colaborador._raw?.id && !colaborador._raw._somenteCpf) return colaborador._raw.id;
    const cpf = String(colaborador._raw?.cpf || '').replace(/\D/g, '');
    if (!cpf || !contratoId) return null;
    const res = await apiGet('/funcionarios', {
        contratoId,
        cpf,
        take: 10,
        page: 1,
        sortAsc: true,
        sortColumn: 'nome'
    });
    const { lista } = parseApiLista(res.dados, res.bruto);
    return lista[0]?.id ?? null;
}

async function consultarDossies() {
    const linhas = await consultarFuncionarios();
    colaboradoresCache = linhas;
    renderListaDossies(linhas);
    document.getElementById('detalheDossie').innerHTML =
        '<p class="placeholder-dossie">Escolha um colaborador na lista.</p>';
    dadosViewAtual = linhas;
    return linhas;
}

async function abrirDossie(idx) {
    const linha = dossieListaFiltrada[idx];
    if (!linha?._raw) return;
    colaboradorDossieSelecionado = idx;
    renderListaDossies(colaboradoresCache);

    const f = obterFiltrosBase();
    const contratoId =
        f.contratoId || linha._raw.contratoId || contratoIdPorNumero(linha._raw.numeroContrato);
    const empresaId = f.contratadaId || linha._raw.empresaContratadaId || linha._raw.empresaId;

    if (!contratoId) {
        document.getElementById('detalheDossie').innerHTML =
            '<p class="sem-dados">Selecione um contrato nos filtros.</p>';
        return;
    }

    const detalheEl = document.getElementById('detalheDossie');
    detalheEl.innerHTML = '<p class="sem-dados">Carregando dossiê...</p>';

    const funcionarioId = await resolverFuncionarioId(linha, contratoId);
    if (!funcionarioId) {
        detalheEl.innerHTML =
            '<p class="sem-dados">Não foi possível obter o ID do funcionário na API. Verifique contrato e CPF.</p>';
        return;
    }

    const [det, treinos, docs] = await Promise.all([
        apiFetch(`/funcionarios/${funcionarioId}/${contratoId}`),
        apiFetch(`/treinamentos-funcionario/funcionario/${funcionarioId}`),
        empresaId
            ? apiFetch(`/documentos-funcionario/funcionario/${funcionarioId}/${empresaId}`)
            : Promise.resolve({ ok: true, dados: [], bruto: null })
    ]);

    const pessoa = det.ok ? det.dados : linha._raw;
    const listaTreinos = parseApiLista(treinos.dados, treinos.bruto).lista;
    const listaDocs = parseApiLista(docs.dados, docs.bruto).lista;

    const campos = [
        ['Nome', pessoa.nome || pessoa.funcionario],
        ['CPF', formatarCpf(pessoa.cpf)],
        ['Função', pessoa.funcao || pessoa.nomeFuncao],
        ['Localizador', pessoa.localizador],
        ['E-mail', pessoa.email],
        ['Telefone', pessoa.telefone || pessoa.celular]
    ];

    const gridCampos = campos
        .filter(([, v]) => v)
        .map(
            ([label, val]) => `
        <div class="campo-dossie"><label>${escapeHtml(label)}</label><p>${escapeHtml(val)}</p></div>`
        )
        .join('');

    const tblTreinos =
        listaTreinos.length === 0
            ? '<p class="sem-dados">Sem treinamentos vinculados.</p>'
            : `<table class="mini-tabela"><thead><tr><th>Treinamento</th><th>Emissão</th><th>Vencimento</th><th>Status</th></tr></thead><tbody>
        ${listaTreinos
            .map((t) => {
                const st = calcularStatus(t.dataVencimento);
                return `<tr><td>${escapeHtml(t.treinamento || t.nomeTreinamento || '-')}</td>
                <td>${formatarData(t.dataEmissao)}</td><td>${formatarData(t.dataVencimento)}</td>
                <td class="${st.classe}">${st.texto}</td></tr>`;
            })
            .join('')}</tbody></table>`;

    const tblDocs =
        listaDocs.length === 0
            ? '<p class="sem-dados">Sem documentos (informe empresa contratada no filtro).</p>'
            : `<table class="mini-tabela"><thead><tr><th>Documento</th><th>Validade</th></tr></thead><tbody>
        ${listaDocs
            .map(
                (d) =>
                    `<tr><td>${escapeHtml(d.tipoExame || d.nome || d.descricao || '-')}</td>
                <td>${formatarData(d.dataValidade || d.dataVencimento)}</td></tr>`
            )
            .join('')}</tbody></table>`;

    detalheEl.innerHTML = `
        <div class="bloco-dossie"><h3>Ficha do colaborador</h3><div class="grid-dossie">${gridCampos || '<p>-</p>'}</div></div>
        <div class="bloco-dossie"><h3>Treinamentos (${listaTreinos.length})</h3>${tblTreinos}</div>
        <div class="bloco-dossie"><h3>Documentos (${listaDocs.length})</h3>${tblDocs}</div>
    `;
}

// ─── Orquestração ─────────────────────────────────────────────

const CONSULTAS = {
    treinamentos: consultarTreinamentos,
    porTreinamento: consultarPorTreinamento,
    catalogo: consultarCatalogo,
    funcionarios: consultarFuncionarios,
    dossies: consultarDossies,
    passaportes: consultarPassaportes,
    documentos: consultarDocumentos
};

async function executarConsulta() {
    const btn = document.getElementById('btnConsultar');
    btn.disabled = true;
    btn.textContent = 'Consultando...';
    ocultarStatus();
    try {
        const fn = CONSULTAS[viewAtiva];
        if (!fn) return;
        await fn();
        const painel = document.getElementById('painelStatus');
        if (!painel.classList.contains('info')) {
            mostrarStatus('Consulta concluída.', 'ok');
        }
    } catch (err) {
        mostrarStatus(err.message || 'Erro na consulta.', 'erro');
        if (String(err.message).includes('Sessão')) encerrarSessao(err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Consultar';
    }
}

function executarExportacao() {
    const mapaTabela = {
        treinamentos: 'tabelaTreinamentos',
        porTreinamento: 'tabelaPorTreinamento',
        catalogo: 'tabelaCatalogo',
        funcionarios: 'tabelaFuncionarios',
        passaportes: 'tabelaPassaportes',
        documentos: 'tabelaDocumentos'
    };
    const containerId = mapaTabela[viewAtiva];
    if (!containerId) {
        alert('Na aba Dossiês use as outras abas para exportar listas em planilha.');
        return;
    }
    const store = tabelaStore[containerId];
    const linhas = store?.filtrado?.length ? store.filtrado : dadosViewAtual;
    if (!linhas.length) {
        alert('Nada para exportar. Faça uma consulta primeiro.');
        return;
    }
    const cols = (store?.colunas || []).map((c) => ({
        titulo: c.titulo,
        chave: c.exportar ?? c.chave,
        exportar: c.exportar ?? c.chave
    }));
    exportarPlanilha(`analise_${viewAtiva}_${Date.now()}`, cols, linhas);
}

// ─── Login / init ─────────────────────────────────────────────

function mostrarErroLogin(texto) {
    const el = document.getElementById('loginErro');
    if (!texto) {
        el.classList.add('oculto');
        el.textContent = '';
        return;
    }
    el.textContent = texto;
    el.classList.remove('oculto');
}

function atualizarStatusSessao(texto) {
    const el = document.getElementById('statusSessao');
    if (el) el.textContent = texto || '';
}

function mostrarTelaApp() {
    document.getElementById('telaLogin').classList.add('oculto');
    document.getElementById('appPrincipal').classList.remove('oculto');
    document.getElementById('usuarioLogado').textContent =
        localStorage.getItem(CONFIG.storage.usuario) || 'Conectado';
    atualizarStatusSessao('Sessão ativa');
}

function mostrarTelaLogin() {
    document.getElementById('telaLogin').classList.remove('oculto');
    document.getElementById('appPrincipal').classList.add('oculto');
}

function encerrarSessao(mensagem) {
    limparSessao();
    listaContratos = [];
    dadosViewAtual = [];
    mostrarTelaLogin();
    if (mensagem) mostrarErroLogin(mensagem);
}

async function iniciarAppAutenticado() {
    mostrarTelaApp();
    agendarRenovacaoToken();
    await carregarContratos();
    await carregarCatalogoTreinamentosFiltro();
    atualizarFiltrosVisiveis();
}

// ─── Toggle de tema + GIFs ─────────────────────────────────────



const GIFS = [
    'https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif',
    'https://media.giphy.com/media/3o7abKhOpu0NwenH3O/giphy.gif',
    'https://media.giphy.com/media/26BRzozg4TCBXv6QU/giphy.gif',
    'https://media.giphy.com/media/26BRv0ThflsHCqDrG/giphy.gif',
    'https://media.giphy.com/media/11sBLVxNs7v6WA/giphy.gif',
    'https://media.giphy.com/media/3o7aD2saalBwwftBIY/giphy.gif',
    'https://media.giphy.com/media/3o7btPCcdNniyf0ArS/giphy.gif'
];

const CHAVE_TEMA = 'passaportePainelTema';

let temaAnimando = false;

function temaEscuroAtivo() {
    return document.documentElement.dataset.theme === 'dark';
}

function aplicarTema(escuro) {
    if (escuro) {
        document.documentElement.dataset.theme = 'dark';
    } else {
        delete document.documentElement.dataset.theme;
    }
    localStorage.setItem(CHAVE_TEMA, escuro ? 'dark' : 'light');
    const input = document.getElementById('inputToggleTema');
    if (input) input.checked = escuro;

    atualizarGifBadge(escuro, escuro);
}

function gifAleatorio(excluir) {
    const pool = excluir ? GIFS.filter((u) => u !== excluir) : GIFS;
    const lista = pool.length ? pool : GIFS;
    return lista[Math.floor(Math.random() * lista.length)];
}

function trocarGifAtual() {
    const img = document.getElementById('gifImg');
    if (!img) return;
    img.src = gifAleatorio(img.src);
}

function atualizarGifBadge(visivel, sortearNovo) {
    const badge = document.getElementById('gifBadge');
    const img = document.getElementById('gifImg');
    if (!badge || !img) return;

    if (!visivel) {
        badge.classList.add('oculto');
        badge.setAttribute('aria-hidden', 'true');
        return;
    }

    if (sortearNovo) {
        img.src = gifAleatorio();
    }
    badge.classList.remove('oculto');
    badge.setAttribute('aria-hidden', 'false');
}

function animarTrocaTema(escuroNovo) {
    const overlay = document.getElementById('temaOverlay');
    const circulo = document.getElementById('temaCirculo');
    if (!overlay || !circulo) {
        aplicarTema(escuroNovo);
        return;
    }

    temaAnimando = true;
    overlay.classList.remove('oculto');
    circulo.style.background = escuroNovo ? '#000000' : '#ffffff';
    circulo.style.transition = 'none';
    circulo.style.width = '0';
    circulo.style.height = '0';
    void circulo.offsetWidth;

    circulo.style.transition = 'width 0.45s cubic-bezier(0.4,0,0.2,1), height 0.45s cubic-bezier(0.4,0,0.2,1)';
    circulo.style.width = '220vmax';
    circulo.style.height = '220vmax';

    setTimeout(() => {
        aplicarTema(escuroNovo);
    }, 220);

    setTimeout(() => {
        circulo.style.width = '0';
        circulo.style.height = '0';
        overlay.classList.add('oculto');
        temaAnimando = false;
    }, 480);
}

function iniciarToggleTema() {
    const salvo = localStorage.getItem(CHAVE_TEMA);
    const escuro = salvo === 'dark';
    aplicarTema(escuro);

    const input = document.getElementById('inputToggleTema');
    const badge = document.getElementById('gifBadge');
    if (badge) {
        badge.addEventListener('click', trocarGifAtual);
    }
    if (!input) return;

    input.addEventListener('change', () => {
        if (temaAnimando) {
            input.checked = temaEscuroAtivo();
            return;
        }
        animarTrocaTema(input.checked);
    });
}

// ─── DOMContentLoaded ─────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    try {
        iniciarToggleTema();
    } catch (err) {
        console.error('Erro ao iniciar tema:', err);
    }

    const agora = new Date();
    const seteDias = new Date(agora.getTime() - 7 * 86400000);
    const ini = document.getElementById('dataInicio');
    const fim = document.getElementById('dataFim');
    if (ini && !ini.value) ini.value = formatarParaInputDatetimeLocal(seteDias);
    if (fim && !fim.value) fim.value = formatarParaInputDatetimeLocal(agora);

    document.getElementById('formLogin').addEventListener('submit', async (e) => {
        e.preventDefault();
        mostrarErroLogin('');
        const btn = document.getElementById('btnEntrar');
        btn.disabled = true;
        btn.textContent = 'Conectando...';
        try {
            await fazerLogin(
                document.getElementById('loginUsuario').value.trim(),
                document.getElementById('loginSenha').value
            );
            await iniciarAppAutenticado();
        } catch (err) {
            mostrarErroLogin(err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Conectar';
        }
    });

    document.getElementById('btnSair').addEventListener('click', () => encerrarSessao());
    document.getElementById('btnConsultar').addEventListener('click', executarConsulta);
    document.getElementById('btnExportar').addEventListener('click', executarExportacao);

    document.querySelectorAll('.aba').forEach((aba) => {
        aba.addEventListener('click', () => trocarView(aba.dataset.view));
    });

    document.getElementById('contrato').addEventListener('change', aoMudarContrato);
    document.getElementById('empresaContratante').addEventListener('change', (e) => {
        carregarContratadas(e.target.value);
    });

    document.getElementById('buscaDossie')?.addEventListener('input', () => {
        if (colaboradoresCache.length) renderListaDossies(colaboradoresCache);
    });

    if (estaAutenticado()) {
        iniciarAppAutenticado().catch(() => encerrarSessao('Sessão inválida.'));
    } else {
        mostrarTelaLogin();
    }
});