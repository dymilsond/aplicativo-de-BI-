/* Painel associativo: a tela em cima do motor.
 *
 * Regra única desta tela: **tudo que mostra número, filtra**. Barra, fatia,
 * ponto do gráfico, cartão de indicador, linha da tabela. E toda seleção
 * aparece como chip removível no topo, para o usuário nunca ficar sem saber
 * por que o número mudou.
 *
 * Gráfico é SVG escrito à mão, sem biblioteca. Não é teimosia: a tela precisa
 * do tri-estado (selecionado, possível, excluído) em cada marca, e biblioteca
 * de gráfico não tem esse conceito — sairia mais código lutando contra ela do
 * que desenhando direto.
 */

import { Motor } from './motor.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

const brl = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const curto = (v) => {
  const n = Number(v) || 0;
  if (Math.abs(n) >= 1e6) return 'R$ ' + (n / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + ' mi';
  if (Math.abs(n) >= 1e3) return 'R$ ' + (n / 1e3).toLocaleString('pt-BR', { maximumFractionDigits: 0 }) + ' mil';
  return 'R$ ' + n.toLocaleString('pt-BR', { maximumFractionDigits: 0 });
};
const num = (v, c = 0) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: c, maximumFractionDigits: c });
const pct = (a, b) => (b ? (100 * a / b).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%' : '–');

const ROTULO_DIM = {
  unidade: 'Unidade',
  categoria: 'Categoria',
  produto: 'Produto',
  forma_pagamento: 'Forma de pagamento',
};

let M = null;             // o motor
let medida = 'receita';   // medida corrente dos gráficos
let periodo = 'tudo';

/* ------------------------------------------------------------------ */
/* Período                                                             */
/* ------------------------------------------------------------------ */

const PERIODOS = [
  ['30', 'Últimos 30 dias', 30],
  ['90', 'Últimos 90 dias', 90],
  ['365', 'Último ano', 365],
  ['tudo', 'Todo o histórico', null],
];

function aplicarPeriodo() {
  const def = PERIODOS.find((p) => p[0] === periodo);
  const fim = M.ultimoDia;
  M.periodoPorDia(def[2] === null ? 0 : Math.max(0, fim - def[2] + 1), fim);
}

/* ------------------------------------------------------------------ */
/* Chips — a seleção sempre visível                                    */
/* ------------------------------------------------------------------ */

function desenharChips() {
  const sels = M.selecoes();
  const box = $('chips');
  box.hidden = !sels.length;
  if (!sels.length) { box.innerHTML = ''; return; }
  box.innerHTML = sels.map((s) => `
    <span class="chip">
      <b>${esc(ROTULO_DIM[s.dim] || s.dim)}:</b>
      ${esc(s.rotulos.length > 2 ? s.rotulos.length + ' selecionados' : s.rotulos.join(', '))}
      <button type="button" data-limpar="${esc(s.dim)}" aria-label="Remover filtro de ${esc(ROTULO_DIM[s.dim])}">✕</button>
    </span>`).join('') +
    `<button type="button" class="chip-limpar" data-limpar="*">Limpar tudo</button>`;
}

/* ------------------------------------------------------------------ */
/* Indicadores                                                         */
/* ------------------------------------------------------------------ */

function desenharIndicadores() {
  const receita = M.total('receita');
  const custo = M.total('custo');
  const cupons = M.total('cupons');
  const qtd = M.total('quantidade');
  const margem = receita - custo;

  const cartao = (rotulo, valor, nota, destaque) => `
    <div class="ind-cartao${destaque ? ' destaque' : ''}">
      <span class="ind-rot">${esc(rotulo)}</span>
      <span class="ind-num">${valor}</span>
      <span class="ind-nota">${nota}</span>
    </div>`;

  $('indicadores').innerHTML =
    cartao('Faturamento', curto(receita), `${num(M.linhasAtivas())} combinações no filtro`, true) +
    cartao('Lucro bruto', curto(margem), `${pct(margem, receita)} do faturamento`) +
    cartao('Atendimentos', num(cupons), `ticket médio ${cupons ? brl(receita / cupons) : '–'}`) +
    cartao('Itens vendidos', num(qtd, 0), `${cupons ? num(qtd / cupons, 1) : '–'} itens por atendimento`);
}

/* ------------------------------------------------------------------ */
/* Barras com tri-estado — o cinza                                      */
/* ------------------------------------------------------------------ */

function desenharBarras(id, dim, opcoes = {}) {
  const itens = M.estado(dim, medida)
    .sort((a, b) => b.valor - a.valor || a.rotulo.localeCompare(b.rotulo, 'pt-BR'));
  const limite = opcoes.limite || itens.length;
  const mostra = itens.slice(0, limite);
  const max = Math.max(1, ...mostra.map((x) => x.valor));
  const total = itens.reduce((s, x) => s + x.valor, 0);
  const temSel = itens.some((x) => x.estado === 'selecionado');

  $(id).innerHTML = mostra.map((x) => `
    <button type="button" class="barra ${x.estado}${temSel && x.estado === 'possivel' ? ' apagada' : ''}"
            data-dim="${esc(dim)}" data-cod="${x.codigo}"
            title="${esc(x.rotulo)}: ${curto(x.valor)} (${pct(x.valor, total)})${x.estado === 'excluido' ? ' — fora da seleção atual' : ''}">
      <span class="barra-nome">${esc(x.rotulo)}</span>
      <span class="barra-trilho"><span class="barra-preenchida" style="width:${(100 * x.valor / max).toFixed(1)}%"></span></span>
      <span class="barra-valor">${x.estado === 'excluido' ? '—' : curto(x.valor)}</span>
    </button>`).join('');

  if (opcoes.contador) {
    const exc = itens.filter((x) => x.estado === 'excluido').length;
    $(opcoes.contador).textContent = exc
      ? `${exc} de ${itens.length} fora da seleção atual`
      : `${itens.length} valores`;
  }
}

/* ------------------------------------------------------------------ */
/* Rosca com tri-estado                                                */
/* ------------------------------------------------------------------ */

const CORES = ['#1351b4', '#e07b00', '#168821', '#c2185b', '#7a4fb5', '#0c7a8a', '#8a6d3b', '#4b5563'];

function desenharRosca(id, dim) {
  const itens = M.estado(dim, medida).sort((a, b) => b.valor - a.valor);
  const vivos = itens.filter((x) => x.valor > 0);
  const total = vivos.reduce((s, x) => s + x.valor, 0);
  const temSel = itens.some((x) => x.estado === 'selecionado');
  const R = 58, C = 2 * Math.PI * R;
  let off = 0, arcos = '';

  vivos.forEach((x, k) => {
    const comp = total ? C * x.valor / total : 0;
    const cor = CORES[k % CORES.length];
    const sel = x.estado === 'selecionado';
    arcos += `<circle class="fatia" data-dim="${esc(dim)}" data-cod="${x.codigo}"
      cx="80" cy="80" r="${R}" fill="none" stroke="${cor}" stroke-width="${sel ? 28 : 22}"
      stroke-dasharray="${comp.toFixed(2)} ${(C - comp).toFixed(2)}" stroke-dashoffset="${-off.toFixed(2)}"
      transform="rotate(-90 80 80)" opacity="${temSel && !sel ? 0.35 : 1}">
      <title>${esc(x.rotulo)}: ${curto(x.valor)} (${pct(x.valor, total)})</title></circle>`;
    off += comp;
    x.cor = cor;
  });

  const legenda = itens.map((x) => `
    <button type="button" class="leg ${x.estado}" data-dim="${esc(dim)}" data-cod="${x.codigo}">
      <i style="background:${x.cor || '#cbd5e1'}"></i>
      <span>${esc(x.rotulo)}</span>
      <b>${x.estado === 'excluido' ? '—' : pct(x.valor, total)}</b>
    </button>`).join('');

  $(id).innerHTML = `<div class="rosca-wrap">
    <svg viewBox="0 0 160 160" role="img" aria-label="${esc(ROTULO_DIM[dim])}">
      ${total ? arcos : '<circle cx="80" cy="80" r="58" fill="none" stroke="#e5e7eb" stroke-width="22"/>'}
      <text x="80" y="76" text-anchor="middle" class="rosca-num">${curto(total)}</text>
      <text x="80" y="95" text-anchor="middle" class="rosca-sub">no filtro</text>
    </svg><div class="legenda">${legenda}</div></div>`;
}

/* ------------------------------------------------------------------ */
/* Evolução mensal — clicável                                          */
/* ------------------------------------------------------------------ */

let mesesSel = new Set();   // chave "aaaa-mm" dos meses clicados

function desenharEvolucao() {
  const { dias, soma } = M.porDia(medida);
  const porMes = new Map();
  dias.forEach((d, k) => {
    const data = new Date(M.origem.getTime() + d * 86400000);
    const chave = `${data.getFullYear()}-${String(data.getMonth()).padStart(2, '0')}`;
    porMes.set(chave, (porMes.get(chave) || 0) + soma[k]);
  });

  let pontos = [...porMes.entries()].map(([chave, valor]) => {
    const [ano, mes] = chave.split('-').map(Number);
    return { chave, valor, ano, mes, rotulo: `${MES[mes]}/${String(ano).slice(2)}` };
  });

  // O mês corrente está pela metade. Plotado como os outros, ele desenha uma
  // queda que não existe — e é em cima dessa queda que o dono decide errado.
  // Sai da linha e vira nota no cabeçalho.
  let parcial = null;
  if (pontos.length > 1) {
    const ultimo = pontos[pontos.length - 1];
    const ultimoDiaDoMes = new Date(ultimo.ano, ultimo.mes + 1, 0).getDate();
    const diaMaisRecente = new Date(M.origem.getTime() + M.data[M.ate - 1] * 86400000);
    const mesmoMes = diaMaisRecente.getFullYear() === ultimo.ano && diaMaisRecente.getMonth() === ultimo.mes;
    if (mesmoMes && diaMaisRecente.getDate() < ultimoDiaDoMes) {
      parcial = pontos.pop();
    }
  }
  $('evo-nota').textContent = parcial
    ? `${parcial.rotulo} está em andamento (${curto(parcial.valor)} até agora) e fica fora da linha`
    : '';

  if (!pontos.length) { $('evolucao').innerHTML = '<p class="vazio">Sem dado no período.</p>'; return; }

  const L = 760, A = 250, ml = 62, mr = 14, mt = 16, mb = 36;
  const max = Math.max(...pontos.map((p) => p.valor), 1);
  const passo = Math.pow(10, Math.floor(Math.log10(max)));
  const topo = Math.ceil(max / passo) * passo;
  const X = (i) => ml + (pontos.length === 1 ? (L - ml - mr) / 2 : i * (L - ml - mr) / (pontos.length - 1));
  const Y = (v) => mt + (1 - v / topo) * (A - mt - mb);

  let g = '';
  for (let k = 0; k <= 4; k++) {
    const v = topo * k / 4;
    g += `<line class="grade" x1="${ml}" x2="${L - mr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>
          <text class="eixo" x="${ml - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${curto(v)}</text>`;
  }
  const linha = pontos.map((p, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.valor).toFixed(1)).join(' ');
  g += `<path d="${linha} L${X(pontos.length - 1).toFixed(1)} ${Y(0).toFixed(1)} L${X(0).toFixed(1)} ${Y(0).toFixed(1)} Z" class="area"/>`;
  g += `<path d="${linha}" class="linha"/>`;

  const pular = pontos.length > 16 ? Math.ceil(pontos.length / 14) : 1;
  pontos.forEach((p, i) => {
    const sel = mesesSel.has(p.chave), x = X(i), y = Y(p.valor);
    if (i % pular === 0 || sel) {
      g += `<text class="eixo${sel ? ' forte' : ''}" x="${x.toFixed(1)}" y="${A - 12}" text-anchor="middle">${p.rotulo}</text>`;
    }
    g += `<circle class="ponto${sel ? ' sel' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${sel ? 6 : 3.5}"/>`;
    g += `<circle class="alvo" data-mes="${p.chave}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="transparent">
            <title>${p.rotulo}: ${brl(p.valor)}</title></circle>`;
  });

  $('evolucao').innerHTML = `<svg viewBox="0 0 ${L} ${A}" role="img" aria-label="Evolução mensal">${g}</svg>`;
}

/* ------------------------------------------------------------------ */
/* Curva do dia (cubo da hora) e dia da semana                         */
/* ------------------------------------------------------------------ */

function desenharHoras() {
  const hd = M.blocos.h_data, hh = M.blocos.h_hora, hr = M.blocos.h_receita;
  const porHora = new Float64Array(24);
  // Só o período: a seleção de produto não se aplica a este cubo, que não
  // tem a dimensão produto. Fica explícito na legenda da tela.
  const diaDe = M.data[M.de], diaAte = M.ate > 0 ? M.data[M.ate - 1] : 0;
  for (let i = 0; i < hd.length; i++) {
    if (hd[i] < diaDe || hd[i] > diaAte) continue;
    porHora[hh[i]] += hr[i] / 100;
  }
  const horas = [...porHora.keys()].filter((h) => porHora[h] > 0);
  if (!horas.length) { $('horas').innerHTML = '<p class="vazio">Sem dado.</p>'; return; }
  const max = Math.max(...porHora);
  $('horas').innerHTML = `<div class="colunas-hora">` + horas.map((h) => `
    <div class="col-hora" title="${h}h: ${curto(porHora[h])}">
      <span class="col-barra" style="height:${(100 * porHora[h] / max).toFixed(1)}%"></span>
      <span class="col-rot">${h}h</span>
    </div>`).join('') + '</div>';
}

function desenharSemana() {
  const { dias, soma } = M.porDia(medida);
  const acc = new Float64Array(7), cont = new Float64Array(7);
  dias.forEach((d, k) => {
    const dw = new Date(M.origem.getTime() + d * 86400000).getDay();
    acc[dw] += soma[k]; cont[dw]++;
  });
  const media = [...acc.keys()].map((i) => (cont[i] ? acc[i] / cont[i] : 0));
  const max = Math.max(1, ...media);
  $('semana').innerHTML = SEMANA.map((nome, i) => `
    <button type="button" class="barra possivel" title="${nome}: ${curto(media[i])} em média">
      <span class="barra-nome">${nome}</span>
      <span class="barra-trilho"><span class="barra-preenchida" style="width:${(100 * media[i] / max).toFixed(1)}%"></span></span>
      <span class="barra-valor">${curto(media[i])}</span>
    </button>`).join('');
}

/* ------------------------------------------------------------------ */
/* Tabela de produtos                                                  */
/* ------------------------------------------------------------------ */

function desenharTabela() {
  const receita = M.porDimensao('produto', 'receita', true);
  const custo = M.porDimensao('produto', 'custo', true);
  const qtd = M.porDimensao('produto', 'quantidade', true);
  const sel = M.sel.produto;

  const linhas = M.rotulos.produto.map((rotulo, codigo) => ({
    codigo, rotulo,
    receita: receita[codigo], margem: receita[codigo] - custo[codigo], qtd: qtd[codigo],
    pct: receita[codigo] ? 100 * (receita[codigo] - custo[codigo]) / receita[codigo] : 0,
    estado: sel.has(codigo) ? 'selecionado' : receita[codigo] > 0 ? 'possivel' : 'excluido',
  })).sort((a, b) => b.receita - a.receita);

  $('tabela').innerHTML = linhas.map((l) => `
    <tr class="${l.estado}" data-dim="produto" data-cod="${l.codigo}">
      <td>${esc(l.rotulo)}</td>
      <td class="n">${l.estado === 'excluido' ? '—' : num(l.qtd, 0)}</td>
      <td class="n">${l.estado === 'excluido' ? '—' : curto(l.receita)}</td>
      <td class="n">${l.estado === 'excluido' ? '—' : curto(l.margem)}</td>
      <td class="n">${l.estado === 'excluido' ? '—'
        : `<span class="selo ${l.pct >= 40 ? 'bom' : l.pct >= 20 ? 'medio' : 'ruim'}">${num(l.pct, 0)}%</span>`}</td>
    </tr>`).join('');
}

/* ------------------------------------------------------------------ */
/* Render geral                                                        */
/* ------------------------------------------------------------------ */

function render() {
  const t0 = performance.now();
  aplicarPeriodo();
  desenharChips();
  desenharIndicadores();
  desenharEvolucao();
  desenharBarras('cat', 'categoria', { contador: 'cat-cont' });
  desenharBarras('prod', 'produto', { limite: 14, contador: 'prod-cont' });
  desenharRosca('pag', 'forma_pagamento');
  desenharBarras('uni', 'unidade', { contador: 'uni-cont' });
  desenharHoras();
  desenharSemana();
  desenharTabela();
  $('tempo').textContent = `${(performance.now() - t0).toFixed(0)} ms`;
}

/* ------------------------------------------------------------------ */
/* Eventos — delegação única                                           */
/* ------------------------------------------------------------------ */

function ligarEventos() {
  document.addEventListener('click', (e) => {
    const alvo = e.target.closest('[data-dim][data-cod]');
    if (alvo) {
      M.alternar(alvo.dataset.dim, Number(alvo.dataset.cod));
      render();
      return;
    }
    const limpar = e.target.closest('[data-limpar]');
    if (limpar) {
      const d = limpar.dataset.limpar;
      if (d === '*') { M.limpar(); mesesSel.clear(); } else M.limpar(d);
      render();
      return;
    }
    const per = e.target.closest('[data-periodo]');
    if (per) {
      periodo = per.dataset.periodo;
      document.querySelectorAll('[data-periodo]').forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.periodo === periodo)));
      render();
      return;
    }
    const med = e.target.closest('[data-medida]');
    if (med) {
      medida = med.dataset.medida;
      document.querySelectorAll('[data-medida]').forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.medida === medida)));
      render();
    }
  });
}

/* ------------------------------------------------------------------ */

export async function iniciar() {
  $('carregando').textContent = 'Carregando o cubo…';
  const t0 = performance.now();
  M = await Motor.carregar('/cubo');
  const ms = performance.now() - t0;

  $('periodos').innerHTML = PERIODOS.map(([k, rot]) =>
    `<button type="button" data-periodo="${k}" aria-pressed="${k === periodo}">${rot}</button>`).join('');

  $('resumo-carga').textContent =
    `${num(M.n)} combinações · ${M.dims.length} dimensões · carregado em ${ms.toFixed(0)} ms`;
  $('carregando').hidden = true;
  $('painel').hidden = false;

  ligarEventos();
  render();
}
