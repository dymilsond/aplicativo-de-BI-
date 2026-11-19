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

import { iniciarFiltros, atualizarFiltros } from './filtros.js';

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
  hora: 'Hora do dia',
  dia_semana: 'Dia da semana',
};

/* ------------------------------------------------------------------ */
/* MODO DE LEITURA — o que acontece quando você seleciona               */
/* ------------------------------------------------------------------ */
/*
 *  Dois modos, e eles não são "zoom ligado/desligado". São duas perguntas
 *  diferentes, e o nome do botão é a pergunta:
 *
 *    FOCO      só a marca escolhida, tela limpa.
 *              Para olhar um número ou mostrar para alguém.
 *
 *    COMPARAR  tudo continua na tela, o que saiu da seleção fica cinza,
 *              e a linha aproxima com três meses de cada lado.
 *              Para explorar e entender a própria base.
 *
 *  Chamar de "zoom" obrigaria o usuário a saber o que a chave faz por
 *  dentro antes de escolher. Chamando pela intenção, ele escolhe certo
 *  sem saber nada.
 *
 *  O que cada chave do preset controla:
 *
 *    contexto          meses visíveis de cada lado do escolhido
 *    ocultarExcluidos  true: o que saiu some · false: fica cinza
 *    pularPropria      false: a dimensão se filtra a si mesma, então
 *                             selecionar uma categoria deixa só ela
 *                      true:  a dimensão é excluída da própria máscara,
 *                             e os números dela não mudam ao selecionar
 *                             dentro dela
 *
 *  Para mudar o padrão de fábrica, troque `MODO_PADRAO`. Para acrescentar
 *  um terceiro modo, basta uma entrada em MODOS — o botão aparece sozinho.
 */
const BASE_ZOOM = {
  ligado: true,
  escala: true,     // o eixo Y também reenquadra no que está visível
  barras: true,     // barra/coluna reescala ignorando o que saiu
  ms: 420,          // duração da aproximação
};

const MODOS = {
  foco: {
    rotulo: 'Foco',
    titulo: 'Ao selecionar, mostra só o que foi escolhido',
    contexto: 0,
    ocultarExcluidos: true,
    pularPropria: false,
    dica: '<strong>Clique em qualquer número para filtrar.</strong> No modo '
        + '<b>Foco</b>, o gráfico fica só com o que você escolheu. Clique de novo '
        + 'para desfazer, ou mude para <b>Comparar</b> ali em cima para ver o '
        + 'escolhido ao lado do resto.',
  },
  comparar: {
    rotulo: 'Comparar',
    titulo: 'Ao selecionar, mantém o resto na tela em cinza',
    contexto: 3,
    ocultarExcluidos: false,
    pularPropria: true,
    dica: '<strong>Clique em qualquer número para filtrar.</strong> No modo '
        + '<b>Comparar</b>, nada some: o que fica <span class="amostra-cinza">cinza</span> '
        + 'existe na base mas não sobrevive à seleção atual. Clique de novo para desfazer.',
  },
};

const MODO_PADRAO = 'foco';
const CHAVE_MODO = 'bi.modo';

let modo = MODO_PADRAO;
let ZOOM = { ...BASE_ZOOM, ...MODOS[MODO_PADRAO] };

/*  A escolha fica no navegador da pessoa.
 *
 *  Não vai para o servidor: isso é preferência de leitura, não dado de
 *  negócio, e mandar para o servidor exigiria tabela de preferência,
 *  rota e migração para resolver uma coisa que o navegador resolve em
 *  três linhas. Fica registrado como dívida: num produto vendido, a
 *  preferência deveria seguir a PESSOA, não a máquina — quem abre do
 *  celular hoje recebe o padrão de fábrica.
 *
 *  Todo acesso em try/catch: em janela anônima, com dados do site
 *  bloqueados ou em alguns modos corporativos, o localStorage LANÇA em
 *  vez de devolver vazio, e um painel não pode deixar de abrir por causa
 *  de uma preferência de botão. */
function modoGuardado() {
  try {
    const m = localStorage.getItem(CHAVE_MODO);
    return MODOS[m] ? m : MODO_PADRAO;
  } catch { return MODO_PADRAO; }
}

function aplicarModo(novo, guardar = true) {
  if (!MODOS[novo]) return;
  modo = novo;
  ZOOM = { ...BASE_ZOOM, ...MODOS[novo] };
  //  A câmera do gráfico de evolução perde a referência: os dois modos
  //  enquadram janelas diferentes, e interpolar de uma para a outra
  //  produziria um movimento sem significado.
  zoomAtual = null; faixaAtual = null;
  if (guardar) { try { localStorage.setItem(CHAVE_MODO, novo); } catch { /* sem persistência, segue */ } }
  document.querySelectorAll('[data-modo]').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.modo === novo));
    b.classList.toggle('ativo', b.dataset.modo === novo);
  });
  const dica = $('dica');
  if (dica) dica.innerHTML = MODOS[novo].dica;
}

//: Quem pediu menos movimento no sistema operacional não recebe animação.
//: Não é enfeite de acessibilidade: movimento involuntário dispara enjoo e
//: enxaqueca em parte real do público.
const SEM_ANIM = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/*  O `innerHTML` troca o elemento inteiro, então a transição do CSS não roda
 *  sozinha: o elemento novo já nasce no tamanho final e não há de onde sair.
 *  O truque é nascer no tamanho ANTERIOR (guardado aqui) e receber o final no
 *  quadro seguinte — aí o CSS tem os dois extremos e anima. */
const _tamanhoAnterior = new Map();

function tamanhoDeSaida(chave, destino) {
  const antes = _tamanhoAnterior.has(chave) ? _tamanhoAnterior.get(chave) : destino;
  _tamanhoAnterior.set(chave, destino);
  return SEM_ANIM ? destino : antes;
}

function soltarAnimacao(id) {
  if (SEM_ANIM) return;
  requestAnimationFrame(() => {
    const box = $(id);
    if (!box) return;
    box.querySelectorAll('[data-fim]').forEach((el) => {
      el.style[el.dataset.eixo === 'h' ? 'height' : 'width'] = el.dataset.fim;
    });
  });
}

let M = null;             // o motor
let medida = 'receita';   // medida corrente dos gráficos

/* As medidas que a tela oferece. `margem` não existe no cubo: é derivada
   (receita − custo). Sem isso, o cartão "Lucro bruto" trocava os gráficos
   para **custo** e rotulava como lucro — número errado com nome certo, que
   é o pior tipo de erro num painel. */
const MEDIDAS = {
  receita:    { rotulo: 'Faturamento',   dinheiro: true },
  margem:     { rotulo: 'Lucro bruto',   dinheiro: true, derivada: ['receita', 'custo'] },
  cupons:     { rotulo: 'Atendimentos',  dinheiro: false },
  quantidade: { rotulo: 'Itens',         dinheiro: false },
};

/** Formata conforme a medida: dinheiro leva R$, contagem não. */
const valorDaMedida = (v) => (MEDIDAS[medida].dinheiro ? curto(v) : num(v, 0));

/** `porDimensao` ciente de medida derivada. */
function porDim(dim, excluindoPropria) {
  const def = MEDIDAS[medida];
  if (!def.derivada) return M.porDimensao(dim, medida, excluindoPropria);
  const [a, b] = def.derivada;
  const x = M.porDimensao(dim, a, excluindoPropria);
  const y = M.porDimensao(dim, b, excluindoPropria);
  const fora = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) fora[i] = x[i] - y[i];
  return fora;
}

/** `estado` ciente de medida derivada, preservando o tri-estado. */
function estadoDim(dim) {
  //  Com `pularPropria: false` a dimensão se filtra a si mesma — é o que
  //  faz a barra selecionada ficar sozinha, como numa ferramenta de BI
  //  comum. O motor aceita os dois, a tela escolhe.
  const pular = !ZOOM.ligado || ZOOM.pularPropria;
  const def = MEDIDAS[medida];
  if (!def.derivada) return M.estado(dim, medida, pular);
  const valores = porDim(dim, pular);
  // O que é "possível" não depende da medida — depende de haver linha viva.
  // Uso a receita para decidir existência e a margem só para o valor.
  const base = M.estado(dim, 'receita', pular);
  return base.map((x) => ({ ...x, valor: valores[x.codigo] }));
}
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
  if (mesEscolhido) {
    const ini = new Date(mesEscolhido.ano, mesEscolhido.mes, 1);
    const fim = new Date(mesEscolhido.ano, mesEscolhido.mes + 1, 0);
    M.periodoPorDia(M.diaDaData(ini), M.diaDaData(fim));
    return;
  }
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
  const temMes = !!mesEscolhido;
  box.hidden = !sels.length && !temMes;
  if (box.hidden) { box.innerHTML = ''; return; }
  const chipMes = temMes ? `
    <span class="chip">
      <b>Mês:</b> ${esc(mesEscolhido.rotulo)}
      <button type="button" data-limpar="@mes" aria-label="Remover o mês">✕</button>
    </span>` : '';
  box.innerHTML = chipMes + sels.map((s) => `
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

  // O cartão também é botão: clicar nele troca a medida que todos os
  // gráficos mostram. Era o único bloco da tela que exibia número e não
  // respondia a nada.
  const cartao = (rotulo, valor, nota, qualMedida) => `
    <button type="button" class="ind-cartao${qualMedida === medida ? ' ativo' : ''}"
            ${qualMedida ? `data-medida="${qualMedida}"` : ''}
            title="${qualMedida ? 'Mostrar ' + rotulo.toLowerCase() + ' nos gráficos' : ''}">
      <span class="ind-rot">${esc(rotulo)}</span>
      <span class="ind-num">${valor}</span>
      <span class="ind-nota">${nota}</span>
    </button>`;

  $('indicadores').innerHTML =
    cartao('Faturamento', curto(receita), `${num(M.linhasAtivas())} combinações no filtro`, 'receita') +
    cartao('Lucro bruto', curto(margem), `${pct(margem, receita)} do faturamento`, 'margem') +
    cartao('Atendimentos', num(cupons), `ticket médio ${cupons ? brl(receita / cupons) : '–'}`, 'cupons') +
    cartao('Itens vendidos', num(qtd, 0), `${cupons ? num(qtd / cupons, 1) : '–'} itens por atendimento`, 'quantidade');
}

/* ------------------------------------------------------------------ */
/* Barras com tri-estado — o cinza                                      */
/* ------------------------------------------------------------------ */

function desenharBarras(id, dim, opcoes = {}) {
  const itens = estadoDim(dim)
    .sort((a, b) => b.valor - a.valor || a.rotulo.localeCompare(b.rotulo, 'pt-BR'));
  const temSel = itens.some((x) => x.estado === 'selecionado');
  const total = itens.reduce((s, x) => s + x.valor, 0);

  //  O zoom da barra é o reenquadramento da escala. Antes, o maior valor
  //  incluía o que a seleção excluiu — e aí selecionar deixava todas as
  //  barras minúsculas, espremidas contra um máximo que não existe mais.
  const base = (ZOOM.ligado && ZOOM.barras)
    ? itens.filter((x) => x.estado !== 'excluido')
    : itens;

  //  O que saiu da seleção some da tela.
  //
  //  A condição é "existe algum excluído", não "existe seleção NESTA
  //  dimensão". Selecionar uma categoria exclui produtos de outras
  //  categorias, e esses produtos têm que sumir do gráfico de produto
  //  também — senão a regra valeria só para o objeto em que se clicou.
  const visiveis = (ZOOM.ligado && ZOOM.ocultarExcluidos)
    ? itens.filter((x) => x.estado !== 'excluido')
    : itens;

  const limite = opcoes.limite || visiveis.length;
  const mostra = visiveis.slice(0, limite);
  const max = Math.max(1, ...(base.length ? base : itens).map((x) => x.valor));

  $(id).innerHTML = mostra.map((x) => {
    const pc = Math.min(100, 100 * x.valor / max).toFixed(1) + '%';
    const saida = tamanhoDeSaida(`${dim}:${x.codigo}`, pc);
    return `
    <button type="button" class="barra ${x.estado}${temSel && x.estado === 'possivel' ? ' apagada' : ''}"
            data-dim="${esc(dim)}" data-cod="${x.codigo}"
            title="${esc(x.rotulo)}: ${valorDaMedida(x.valor)} (${pct(x.valor, total)})${x.estado === 'excluido' ? ' — fora da seleção atual' : ''}">
      <span class="barra-nome">${esc(x.rotulo)}</span>
      <span class="barra-trilho"><span class="barra-preenchida" data-fim="${pc}" style="width:${saida}"></span></span>
      <span class="barra-valor">${x.estado === 'excluido' ? '—' : valorDaMedida(x.valor)}</span>
    </button>`;
  }).join('');
  soltarAnimacao(id);

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

/*  Deslocamento da fatia selecionada, em unidades do viewBox (160x160).
 *  É o "zoom" possível numa rosca: a fatia sai do prato. */
const EXPLODE = 8;

function desenharRosca(id, dim) {
  const itens = estadoDim(dim).sort((a, b) => b.valor - a.valor);
  const vivos = itens.filter((x) => x.valor > 0);
  const total = vivos.reduce((s, x) => s + x.valor, 0);
  const temSel = itens.some((x) => x.estado === 'selecionado');

  /*  O denominador do percentual é calculado SEMPRE com a própria dimensão
   *  pulada, mesmo quando o desenho não pula.
   *
   *  Sem isso, com a fatia selecionada sozinha no prato, numerador e
   *  denominador viram o mesmo número e o centro escreve "100%". A conta
   *  estaria certa e a resposta seria inútil: quem clicou perguntou "quanto
   *  esta fatia é do total?" e receberia "esta fatia é tudo que sobrou".
   *
   *  Então o desenho obedece ao ZOOM (fatia sozinha, como pedido) e o
   *  número obedece à pergunta (28,5% de R$ 375 mil). São duas coisas
   *  diferentes e não precisam concordar. */
  const base = porDim(dim, true);
  const totalBase = base.reduce((s, v) => s + v, 0);
  const valSel = [...M.sel[dim]].reduce((s, c) => s + base[c], 0);
  const R = 58, C = 2 * Math.PI * R;
  let off = 0, arcos = '';

  vivos.forEach((x, k) => {
    const comp = total ? C * x.valor / total : 0;
    const cor = CORES[k % CORES.length];
    const sel = x.estado === 'selecionado';

    //  Ângulo do meio da fatia, medido do topo no sentido horário (é onde o
    //  rotate(-90) coloca a origem). É por ele que a fatia sabe para que
    //  lado sair.
    const meio = total ? ((off + comp / 2) / C) * 2 * Math.PI : 0;
    const d = (ZOOM.ligado && sel) ? EXPLODE : 0;
    const dx = (Math.sin(meio) * d).toFixed(2);
    const dy = (-Math.cos(meio) * d).toFixed(2);

    arcos += `<g transform="translate(${dx} ${dy})"><circle class="fatia${sel ? ' sel' : ''}" data-dim="${esc(dim)}" data-cod="${x.codigo}"
      cx="80" cy="80" r="${R}" fill="none" stroke="${cor}" stroke-width="${sel ? 28 : 22}"
      stroke-dasharray="${comp.toFixed(2)} ${(C - comp).toFixed(2)}" stroke-dashoffset="${-off.toFixed(2)}"
      transform="rotate(-90 80 80)" opacity="${temSel && !sel ? 0.3 : 1}">
      <title>${esc(x.rotulo)}: ${valorDaMedida(base[x.codigo])} (${pct(base[x.codigo], totalBase)})</title></circle></g>`;
    off += comp;
    x.cor = cor;
  });

  const legenda = itens.map((x) => `
    <button type="button" class="leg ${x.estado}" data-dim="${esc(dim)}" data-cod="${x.codigo}">
      <i style="background:${x.cor || '#cbd5e1'}"></i>
      <span>${esc(x.rotulo)}</span>
      <b>${pct(base[x.codigo], totalBase)}</b>
    </button>`).join('');

  /*  O centro responde a pergunta que a seleção realmente faz.
   *
   *  Numa pizza o denominador encolhe junto com a seleção: selecionar uma
   *  fatia faz ela virar 100% de si mesma, e a ferramenta escreve "100%" na
   *  tela. A conta está certa e a resposta é inútil — o usuário perguntou
   *  "quanto esta fatia é do total?" e recebeu "esta fatia é tudo que
   *  sobrou". Tautologia.
   *
   *  Aqui o `skip` já mantém o denominador inteiro (a dimensão é excluída
   *  da própria máscara), então o percentual da legenda nunca vira 100%.
   *  O centro fecha o raciocínio: mostra o valor selecionado e, embaixo,
   *  contra o que ele está sendo comparado. */
  const centroNum = temSel ? valorDaMedida(valSel) : valorDaMedida(totalBase);
  const centroSub = temSel ? `${pct(valSel, totalBase)} de ${valorDaMedida(totalBase)}` : 'no filtro';

  $(id).innerHTML = `<div class="rosca-wrap">
    <svg viewBox="0 0 160 160" role="img" aria-label="${esc(ROTULO_DIM[dim])}">
      ${total ? arcos : '<circle cx="80" cy="80" r="58" fill="none" stroke="#e5e7eb" stroke-width="22"/>'}
      <text x="80" y="76" text-anchor="middle" class="rosca-num">${centroNum}</text>
      <text x="80" y="95" text-anchor="middle" class="rosca-sub">${esc(centroSub)}</text>
    </svg><div class="legenda">${legenda}</div></div>`;
}

/* ------------------------------------------------------------------ */
/* Evolução mensal — clicável                                          */
/* ------------------------------------------------------------------ */

// Mês escolhido clicando no gráfico de evolução. Não é dimensão do cubo:
// é um recorte de período, então vira fatia de linhas como qualquer período.
let mesEscolhido = null;   // { ano, mes, rotulo } ou null

/*  A câmera do gráfico de evolução.
 *
 *  `evoPontos` guarda o que foi apurado; `zoomAtual` e `topoAtual` são a
 *  posição corrente da câmera. A animação redesenha só o SVG a partir do
 *  cache — não reapura nada no motor, senão seriam ~25 varreduras do cubo
 *  por clique. Com o cache, cada quadro é montagem de string sobre 19
 *  pontos: custo irrelevante. */
let evoPontos = [];
let evoParcial = null;
let zoomAtual = null;
let faixaAtual = null;   // {piso, teto} do eixo Y em curso
let zoomAnim = 0;

/** Janela de índices que a câmera deve enquadrar. */
function janelaAlvo() {
  const n = evoPontos.length;
  const tudo = { ini: 0, fim: Math.max(0, n - 1) };
  if (!ZOOM.ligado || !mesEscolhido || !n) return tudo;
  const i = evoPontos.findIndex((p) => p.ano === mesEscolhido.ano && p.mes === mesEscolhido.mes);
  if (i < 0) return tudo;

  const c = Math.max(0, ZOOM.contexto);
  let a = i - c, b = i + c;
  //  Encostar na borda não pode encolher a janela: o zoom teria tamanho
  //  diferente só porque o mês escolhido é o primeiro ou o último, e a
  //  comparação entre dois cliques deixaria de valer.
  if (a < 0) { b = Math.min(n - 1, b - a); a = 0; }
  if (b > n - 1) { a = Math.max(0, a - (b - (n - 1))); b = n - 1; }
  return { ini: a, fim: b };
}

/** Passo "redondo" (1, 2 ou 5 vezes potência de 10) para a amplitude dada. */
function passoBonito(amplitude) {
  const p = Math.pow(10, Math.floor(Math.log10(Math.abs(amplitude) || 1)));
  const n = (amplitude || 1) / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/**  Faixa do eixo Y — este é o zoom vertical, e é ele que faltava.
 *
 *   Sem aproximação o eixo começa em ZERO, sempre. Cortar a base exagera a
 *   variação e é o truque mais velho do gráfico enganoso: uma oscilação de
 *   2% vira um precipício. Não é negociável no estado geral da tela.
 *
 *   Aproximando é outra conversa: o usuário pediu para chegar perto de sete
 *   meses, e chegar perto *é* deixar de olhar os R$ 0 que ninguém faturou.
 *   Com piso em zero, 252 mil e 386 mil viram dois pontos quase colados num
 *   terço superior do gráfico — some justamente a diferença que motivou o
 *   clique. Por isso o corte da base só existe com o zoom ligado, e vem com
 *   a marca de quebra no eixo para ninguém ler a inclinação como absoluta.
 */
function faixaDe(jan) {
  const a = Math.max(0, Math.floor(jan.ini));
  const b = Math.min(evoPontos.length - 1, Math.ceil(jan.fim));
  const dentro = evoPontos.slice(a, b + 1);
  const usa = dentro.length ? dentro : evoPontos;
  const max = Math.max(1, ...usa.map((x) => x.valor));

  //  Cortar a base exige PELO MENOS DOIS pontos na janela. Com um só não
  //  há variação para enquadrar: a faixa vira 8% do valor, e os cinco
  //  rótulos do eixo saem todos iguais ("R$ 1,2 mi" cinco vezes, visto na
  //  tela). Com um ponto, o eixo volta a começar em zero — que também é o
  //  que uma ferramenta de BI comum mostra nesse caso.
  const aproximando = ZOOM.ligado && ZOOM.escala && !!mesEscolhido
                   && dentro.length >= 2 && dentro.length < evoPontos.length;

  if (!aproximando) {
    const passo = Math.pow(10, Math.floor(Math.log10(max)));
    return { piso: 0, teto: Math.ceil(max / passo) * passo };
  }

  const min = Math.min(...usa.map((x) => x.valor));
  //  Folga: um quarto da variação de cada lado, com piso de 4% do maior
  //  valor para o caso de a janela ser praticamente plana (senão o eixo
  //  colapsaria num fio e o ruído viraria montanha).
  const folga = Math.max((max - min) * 0.25, max * 0.04);
  const passo = passoBonito((max + folga - Math.max(0, min - folga)) / 4);
  const teto = Math.ceil((max + folga) / passo) * passo;
  const piso = Math.max(0, Math.floor(Math.max(0, min - folga) / passo) * passo);
  return { piso: piso >= teto ? 0 : piso, teto };
}

function animarZoom() {
  cancelAnimationFrame(zoomAnim);
  const alvo = janelaAlvo();
  const fx = faixaDe(alvo);
  const de = zoomAtual || alvo;
  const fxDe = faixaAtual || fx;

  const quieto = Math.abs(de.ini - alvo.ini) < 0.01
              && Math.abs(de.fim - alvo.fim) < 0.01
              && Math.abs(fxDe.teto - fx.teto) < 0.01
              && Math.abs(fxDe.piso - fx.piso) < 0.01;
  if (SEM_ANIM || !ZOOM.ms || quieto) {
    zoomAtual = alvo; faixaAtual = fx;
    pintarEvolucao(alvo, fx);
    return;
  }

  const t0 = performance.now();
  const passo = (agora) => {
    const t = Math.min(1, (agora - t0) / ZOOM.ms);
    const e = 1 - Math.pow(1 - t, 3);          // ease-out cúbico
    zoomAtual = { ini: de.ini + (alvo.ini - de.ini) * e, fim: de.fim + (alvo.fim - de.fim) * e };
    faixaAtual = { piso: fxDe.piso + (fx.piso - fxDe.piso) * e, teto: fxDe.teto + (fx.teto - fxDe.teto) * e };
    pintarEvolucao(zoomAtual, faixaAtual);
    if (t < 1) zoomAnim = requestAnimationFrame(passo);
  };
  zoomAnim = requestAnimationFrame(passo);
}

function desenharEvolucao() {
  // A linha apura SEMPRE o histórico inteiro, mesmo com um mês escolhido.
  // O que o mês escolhido faz é mover a câmera — não apagar o passado.
  // Sem isso, clicar num ponto reduziria o gráfico a esse ponto e não
  // haveria como voltar clicando.
  const deAntes = M.de, ateAntes = M.ate;
  if (mesEscolhido) M.periodoPorDia(0, M.ultimoDia);
  const def = MEDIDAS[medida];
  const { dias, soma } = def.derivada
    ? (() => {
        const a = M.porDia(def.derivada[0]), b = M.porDia(def.derivada[1]);
        return { dias: a.dias, soma: a.soma.map((v, i) => v - b.soma[i]) };
      })()
    : M.porDia(medida);
  M.de = deAntes; M.ate = ateAntes;

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
    if (mesmoMes && diaMaisRecente.getDate() < ultimoDiaDoMes) parcial = pontos.pop();
  }

  //  Se o conjunto de meses mudou (outro período, outra seleção), a câmera
  //  perde a referência e precisa recomeçar — interpolar entre dois eixos
  //  diferentes produziria um movimento sem significado.
  const assinatura = pontos.length + '|' + (pontos[0] && pontos[0].chave) + '|' + (pontos[pontos.length - 1] || {}).chave;
  if (assinatura !== desenharEvolucao._assinatura) {
    desenharEvolucao._assinatura = assinatura;
    zoomAtual = null; faixaAtual = null;
  }

  evoPontos = pontos;
  evoParcial = parcial;

  if (!pontos.length) { $('evolucao').innerHTML = '<p class="vazio">Sem dado no período.</p>'; $('evo-nota').innerHTML = ''; return; }
  animarZoom();
}

/** Desenha o SVG a partir do cache, para a janela e a faixa informadas. */
function pintarEvolucao(jan, fx) {
  const { piso, teto } = fx;
  const amp = Math.max(1e-9, teto - piso);
  const pontos = evoPontos;

  /*  O viewBox acompanha a largura REAL do container, em vez de ser fixo
   *  em 760.
   *
   *  Um SVG com viewBox escala tudo junto — inclusive a tipografia. Com
   *  760 fixo num monitor de 2560 px, o fator vira 2,3: a fonte de 10,5
   *  do eixo é desenhada com 24 px na tela, e a altura de 250 vira 580 px
   *  de cartão quase vazio. Casando o viewBox com o pixel real, 1 unidade
   *  = 1 pixel e os tamanhos ficam como foram escritos.
   *
   *  O piso de 560 é para o SVG não degenerar antes de o CSS entrar em
   *  modo estreito; o teto de 1800 evita um gráfico tão largo que o olho
   *  perde a linha ao varrer de ponta a ponta. */
  const caixa = $('evolucao').clientWidth || 760;
  const L = Math.min(1800, Math.max(560, caixa));
  const A = 250, ml = 62, mr = 14, mt = 16, mb = 36;
  const larg = L - ml - mr;
  const vao = jan.fim - jan.ini;
  //  Janela de um ponto só (contexto 0): não há vão para distribuir, então o
  //  ponto vai ao centro. É o caso em que o resultado fica igual ao do Qlik —
  //  de propósito, porque é uma escolha sua no bloco ZOOM.
  const X = (i) => (vao < 0.001 ? ml + larg / 2 : ml + (i - jan.ini) * larg / vao);
  const Y = (v) => mt + (1 - (v - piso) / amp) * (A - mt - mb);

  /*  Rótulo centralizado no ponto da borda transborda o recorte e sai
   *  cortado pela metade ("R$ 99" em vez de "R$ 995 mil"). Nas pontas o
   *  texto encosta no eixo em vez de centralizar. Estimo a largura por
   *  caractere — medir de verdade exigiria tocar no DOM a cada quadro da
   *  animação, e 3,2 px por caractere erra pouco nesta fonte. */
  const ancorar = (x, texto) => {
    const meia = 2 + String(texto).length * 1.6;
    if (x - ml < meia) return ['start', ml];
    if (L - mr - x < meia) return ['end', L - mr];
    return ['middle', x];
  };

  /*  Quais pontos entram no desenho.
   *
   *  Com a janela de um mês só o vão é ZERO, então X(i) devolve o centro
   *  para TODO índice — e os 25 pontos empilham numa linha vertical no meio
   *  da tela. Foi o que apareceu na verificação. Nesse caso desenha-se só o
   *  ponto escolhido: um ponto não tem linha nem área.
   *
   *  Com mais de um, entra também um vizinho de cada lado, para a linha
   *  continuar saindo pelas bordas em vez de terminar no ar. O recorte do
   *  SVG corta o excedente. */
  const soUm = vao < 0.001;
  const dePt = soUm ? Math.round(jan.ini) : Math.max(0, Math.floor(jan.ini) - 1);
  const atePt = soUm ? Math.round(jan.ini) : Math.min(pontos.length - 1, Math.ceil(jan.fim) + 1);

  let g = '';
  for (let k = 0; k <= 4; k++) {
    const v = piso + amp * k / 4;
    g += `<line class="grade" x1="${ml}" x2="${L - mr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}"/>
          <text class="eixo" x="${ml - 8}" y="${(Y(v) + 4).toFixed(1)}" text-anchor="end">${valorDaMedida(v)}</text>`;
  }

  //  Marca de quebra: o eixo não começa em zero, e quem olhar de longe tem
  //  que ver isso antes de ler a inclinação como se fosse absoluta. Sem a
  //  marca, o corte da base é desonestidade gráfica; com ela, é zoom.
  if (piso > 0) {
    const yb = Y(piso);
    g += `<path class="corte-eixo" d="M${ml - 13} ${(yb - 2).toFixed(1)} l6 -4 l-6 -4"
            fill="none"/>
          <path class="corte-eixo" d="M${ml - 13} ${(yb + 7).toFixed(1)} l6 -4 l-6 -4"
            fill="none"/>
          <title>eixo cortado: começa em ${valorDaMedida(piso)}, não em zero</title>`;
  }

  //  Tudo que é série entra no recorte: fora da janela a linha continua
  //  existindo (é o que torna o movimento legível) mas não invade os eixos.
  let serie = '';
  if (!soUm) {
    let d = '';
    for (let i = dePt; i <= atePt; i++) {
      d += (i === dePt ? 'M' : ' L') + X(i).toFixed(1) + ' ' + Y(pontos[i].valor).toFixed(1);
    }
    serie += `<path d="${d} L${X(atePt).toFixed(1)} ${Y(piso).toFixed(1)} L${X(dePt).toFixed(1)} ${Y(piso).toFixed(1)} Z" class="area"/>`;
    serie += `<path d="${d}" class="linha"/>`;
  }

  const dentro = (i) => i >= jan.ini - 0.5 && i <= jan.fim + 0.5;
  const visiveis = pontos.filter((_, i) => dentro(i)).length;

  /*  Valor sobre o ponto — quais entram.
   *
   *  Primeira tentativa minha foi contar quantos cabem e alternar duas
   *  alturas. Não funciona: o rótulo acompanha a altura do próprio ponto,
   *  então quando a linha sobe o deslocamento APROXIMA em vez de afastar.
   *  Deu `67.202` escrito por cima de `72.882` na verificação em tela.
   *
   *  O que funciona é testar colisão de verdade, em duas dimensões. Cada
   *  rótulo reserva uma caixa; quem bateria numa caixa já reservada não é
   *  desenhado. O selecionado escolhe primeiro — é o que a pessoa está
   *  olhando e não pode perder a vez para um vizinho qualquer.
   *
   *  Resultado: com rótulo curto (uma contagem) entram os 25; com rótulo
   *  longo ("R$ 1,2 mi") entram os que couberem, espaçados; no zoom entram
   *  todos. Nunca sobrepõe, que é a única regra inegociável — número por
   *  cima de número não é densidade, é erro de leitura esperando acontecer.
   *
   *  Largura por caractere estimada em 6,6 px: medir no DOM a cada quadro
   *  da animação custaria um reflow por rótulo. Erra para mais, e errar
   *  para mais aqui significa esconder em vez de sobrepor. */
  const comValor = new Set();
  const caixas = [];
  const tentarRotulo = (i) => {
    const texto = valorDaMedida(pontos[i].valor);
    const x = X(i), y = Y(pontos[i].valor) - 12;
    const [an, ax] = ancorar(x, texto);
    const w = texto.length * 6.6;
    const x0 = (an === 'start' ? ax : an === 'end' ? ax - w : ax - w / 2) - 3;
    const c = { x0, x1: x0 + w + 6, y0: y - 12, y1: y + 4 };
    if (caixas.some((b) => c.x0 < b.x1 && c.x1 > b.x0 && c.y0 < b.y1 && c.y1 > b.y0)) return;
    caixas.push(c);
    comValor.add(i);
  };
  const iSel = pontos.findIndex((p) => mesEscolhido && mesEscolhido.ano === p.ano && mesEscolhido.mes === p.mes);
  if (iSel >= 0 && dentro(iSel)) tentarRotulo(iSel);
  pontos.forEach((_, i) => { if (i !== iSel && dentro(i)) tentarRotulo(i); });

  const pular = visiveis > 16 ? Math.ceil(visiveis / 14) : 1;
  let k = 0;
  for (let i = dePt; i <= atePt; i++) {
    const p = pontos[i];
    const sel = !!mesEscolhido && mesEscolhido.ano === p.ano && mesEscolhido.mes === p.mes;
    const x = X(i), y = Y(p.valor);
    const visivel = dentro(i);
    if (visivel && (k++ % pular === 0 || sel)) {
      const [an, ax] = ancorar(x, p.rotulo);
      g += `<text class="eixo${sel ? ' forte' : ''}" x="${ax.toFixed(1)}" y="${A - 12}" text-anchor="${an}">${p.rotulo}</text>`;
    }
    serie += `<circle class="ponto${sel ? ' sel' : ''}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${sel ? 6 : 3.5}"/>`;
    //  Com o zoom aberto o valor cabe na tela: mostra o número em cima do
    //  ponto, como no painel do Qlik. Com 19 meses não cabe e vira sujeira.
    if (comValor.has(i)) {
      const rot = valorDaMedida(p.valor);
      const [an, ax] = ancorar(x, rot);
      serie += `<text class="evo-val${sel ? ' forte' : ''}" x="${ax.toFixed(1)}" y="${(y - 12).toFixed(1)}" text-anchor="${an}">${rot}</text>`;
    }
    if (visivel) {
      serie += `<circle class="alvo" data-ano="${p.ano}" data-mes="${p.mes}" data-rot="${p.rotulo}"
            cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="transparent">
            <title>${p.rotulo}: ${MEDIDAS[medida].dinheiro ? brl(p.valor) : num(p.valor, 0)} — ${sel ? 'clique para voltar ao histórico' : 'clique para aproximar neste mês'}</title></circle>`;
    }
  }

  $('evolucao').innerHTML = `<svg viewBox="0 0 ${L} ${A}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Evolução mensal">
    <defs><clipPath id="corte-evo"><rect x="${ml}" y="0" width="${larg}" height="${A}"/></clipPath></defs>
    ${g}<g clip-path="url(#corte-evo)">${serie}</g></svg>`;

  //  A nota do cabeçalho carrega o mês parcial e, quando há zoom, a saída.
  //  O ✕ do chip já desfaz, mas quem está olhando o gráfico não olha o chip.
  const nota = evoParcial
    ? `${evoParcial.rotulo} está em andamento (${valorDaMedida(evoParcial.valor)} até agora) e fica fora da linha`
    : '';
  const cortado = piso > 0
    ? `<span class="aviso-corte" title="O eixo começa em ${esc(valorDaMedida(piso))} para a variação do período caber na tela. Olhe os números, não só a inclinação.">eixo a partir de ${esc(valorDaMedida(piso))}</span>`
    : '';
  const voltar = (ZOOM.ligado && mesEscolhido)
    ? `<button type="button" class="evo-voltar" data-limpar="@mes">⤢ ver os ${pontos.length} meses</button>`
    : '';
  $('evo-nota').innerHTML = esc(nota) + cortado + voltar;
}

/* ------------------------------------------------------------------ */
/* Curva do dia (cubo da hora) e dia da semana                         */
/* ------------------------------------------------------------------ */

function desenharHoras() {
  const itens = estadoDim('hora').sort((a, b) => Number(a.rotulo) - Number(b.rotulo));
  const temSel = itens.some((x) => x.estado === 'selecionado');
  const base = (ZOOM.ligado && ZOOM.barras)
    ? itens.filter((x) => x.estado !== 'excluido')
    : itens;
  const max = Math.max(1, ...(base.length ? base : itens).map((x) => x.valor));
  const mostra = (ZOOM.ligado && ZOOM.ocultarExcluidos)
    ? itens.filter((x) => x.estado !== 'excluido')
    : itens;

  $('horas').innerHTML = `<div class="colunas-hora">` + mostra.map((x) => {
    const pc = Math.min(100, 100 * x.valor / max).toFixed(1) + '%';
    const saida = tamanhoDeSaida(`hora:${x.codigo}`, pc);
    return `
    <button type="button" class="col-hora ${x.estado}${temSel && x.estado === 'possivel' ? ' apagada' : ''}"
            data-dim="hora" data-cod="${x.codigo}"
            title="${x.rotulo}h: ${valorDaMedida(x.valor)}${x.estado === 'excluido' ? ' — fora da seleção' : ''}">
      <span class="col-barra" data-fim="${pc}" data-eixo="h" style="height:${saida}"></span>
      <span class="col-rot">${x.rotulo}h</span>
    </button>`;
  }).join('') + '</div>';
  soltarAnimacao('horas');
}

const ORDEM_SEMANA = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];

function desenharSemana() {
  const itens = estadoDim('dia_semana')
    .sort((a, b) => ORDEM_SEMANA.indexOf(a.rotulo) - ORDEM_SEMANA.indexOf(b.rotulo));
  const temSel = itens.some((x) => x.estado === 'selecionado');
  const base = (ZOOM.ligado && ZOOM.barras)
    ? itens.filter((x) => x.estado !== 'excluido')
    : itens;
  const max = Math.max(1, ...(base.length ? base : itens).map((x) => x.valor));
  const mostra = (ZOOM.ligado && ZOOM.ocultarExcluidos)
    ? itens.filter((x) => x.estado !== 'excluido')
    : itens;

  $('semana').innerHTML = mostra.map((x) => {
    const pc = Math.min(100, 100 * x.valor / max).toFixed(1) + '%';
    const saida = tamanhoDeSaida(`dia_semana:${x.codigo}`, pc);
    return `
    <button type="button" class="barra ${x.estado}${temSel && x.estado === 'possivel' ? ' apagada' : ''}"
            data-dim="dia_semana" data-cod="${x.codigo}"
            title="${esc(x.rotulo)}: ${valorDaMedida(x.valor)}">
      <span class="barra-nome">${esc(x.rotulo)}</span>
      <span class="barra-trilho"><span class="barra-preenchida" data-fim="${pc}" style="width:${saida}"></span></span>
      <span class="barra-valor">${x.estado === 'excluido' ? '—' : valorDaMedida(x.valor)}</span>
    </button>`;
  }).join('');
  soltarAnimacao('semana');
}

/* ------------------------------------------------------------------ */
/* Tabela de produtos                                                  */
/* ------------------------------------------------------------------ */

function desenharTabela() {
  const pular = !ZOOM.ligado || ZOOM.pularPropria;
  const receita = M.porDimensao('produto', 'receita', pular);
  const custo = M.porDimensao('produto', 'custo', pular);
  const qtd = M.porDimensao('produto', 'quantidade', pular);
  const sel = M.sel.produto;

  const linhas = M.rotulos.produto.map((rotulo, codigo) => ({
    codigo, rotulo,
    receita: receita[codigo], margem: receita[codigo] - custo[codigo], qtd: qtd[codigo],
    pct: receita[codigo] ? 100 * (receita[codigo] - custo[codigo]) / receita[codigo] : 0,
    estado: sel.has(codigo) ? 'selecionado' : receita[codigo] > 0 ? 'possivel' : 'excluido',
  //  O "zoom" possível numa tabela: a linha escolhida sobe ao topo.
  //
  //  A tabela de produtos rola, e o produto selecionado pode estar na
  //  linha 40 — fora da vista. Clicar e não ver nada acontecer é o mesmo
  //  que o gráfico não responder. Subir a linha é aproximar dela sem
  //  esconder nenhuma outra: as excluídas continuam abaixo, com "—",
  //  porque o que caiu fora da seleção também é informação sobre a base.
  })).sort((a, b) =>
    (ZOOM.ligado ? (b.estado === 'selecionado') - (a.estado === 'selecionado') : 0)
    || b.receita - a.receita);

  const visiveis = (ZOOM.ligado && ZOOM.ocultarExcluidos)
    ? linhas.filter((l) => l.estado !== 'excluido')
    : linhas;

  $('tabela').innerHTML = visiveis.map((l) => `
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
  atualizarFiltros();
  $('tempo').textContent = `${(performance.now() - t0).toFixed(0)} ms`;
}

/* ------------------------------------------------------------------ */
/* Eventos — delegação única                                           */
/* ------------------------------------------------------------------ */

function ligarEventos() {
  /*  O viewBox do gráfico de evolução depende da largura do container,
   *  então mudar o tamanho da janela exige redesenhar — senão o SVG fica
   *  esticado ou comprimido pelo navegador, com a tipografia junto.
   *  Com espera: `resize` dispara dezenas de vezes por arrasto, e cada
   *  render completo varre o cubo. */
  let esperaResize = 0;
  window.addEventListener('resize', () => {
    clearTimeout(esperaResize);
    esperaResize = setTimeout(() => { if (M) render(); }, 150);
  });

  document.addEventListener('click', (e) => {
    const alvo = e.target.closest('[data-dim][data-cod]');
    if (alvo) {
      M.alternar(alvo.dataset.dim, Number(alvo.dataset.cod));
      render();
      return;
    }
    const ponto = e.target.closest('.alvo[data-ano]');
    if (ponto) {
      const ano = Number(ponto.dataset.ano), mes = Number(ponto.dataset.mes);
      const igual = mesEscolhido && mesEscolhido.ano === ano && mesEscolhido.mes === mes;
      mesEscolhido = igual ? null : { ano, mes, rotulo: ponto.dataset.rot };
      render();
      return;
    }
    const limpar = e.target.closest('[data-limpar]');
    if (limpar) {
      const d = limpar.dataset.limpar;
      if (d === '*') { M.limpar(); mesEscolhido = null; }
      else if (d === '@mes') mesEscolhido = null;
      else M.limpar(d);
      render();
      return;
    }
    const per = e.target.closest('[data-periodo]');
    if (per) {
      periodo = per.dataset.periodo;
      mesEscolhido = null;   // escolher período na barra manda no gráfico
      document.querySelectorAll('[data-periodo]').forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.periodo === periodo)));
      render();
      return;
    }
    const md = e.target.closest('[data-modo]');
    if (md) {
      aplicarModo(md.dataset.modo);
      render();
      return;
    }
    const med = e.target.closest('[data-medida]');
    if (med) {
      medida = med.dataset.medida;
      document.querySelectorAll('[data-medida]').forEach((b) => {
        b.setAttribute('aria-pressed', String(b.dataset.medida === medida));
        b.classList.toggle('ativo', b.dataset.medida === medida);
      });
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

  //  Os botões saem do próprio MODOS: acrescentar um terceiro modo lá em
  //  cima faz o botão aparecer aqui sem tocar nesta linha.
  $('modos').innerHTML = Object.entries(MODOS).map(([k, m]) =>
    `<button type="button" data-modo="${k}" title="${esc(m.titulo)}" aria-pressed="false">${esc(m.rotulo)}</button>`).join('');
  aplicarModo(modoGuardado(), false);

  $('periodos').innerHTML = PERIODOS.map(([k, rot]) =>
    `<button type="button" data-periodo="${k}" aria-pressed="${k === periodo}">${rot}</button>`).join('');

  $('resumo-carga').textContent =
    `${num(M.n)} combinações · ${M.dims.length} dimensões · carregado em ${ms.toFixed(0)} ms`;
  $('carregando').hidden = true;
  $('painel').hidden = false;

  ligarEventos();
  //  O filtro recebe o que precisa do painel em vez de importar de volta:
  //  dependência num sentido só. `medidaAtual` é função, não valor, porque
  //  a medida muda e o filtro tem que ler a vigente, não a do carregamento.
  iniciarFiltros({
    M,
    ROTULO_DIM,
    //  A medida serve só para ORDENAR a lista do filtro (o maior no topo).
    //  O valor em si não é mostrado lá — ver o comentário em `itensDe`.
    medidaAtual: () => (MEDIDAS[medida].derivada ? 'receita' : medida),
    render,
  });
  render();
}
