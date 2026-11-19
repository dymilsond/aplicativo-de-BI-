/*  Painel de filtros — coluna lateral esquerda.
 *
 *  O painel já filtra no clique, mas isso só alcança o que está desenhado:
 *  o gráfico de produto mostra os 14 maiores, e o 40º produto não tem onde
 *  ser clicado. É para ele que o filtro existe.
 *
 *  Três entradas, de cima para baixo:
 *
 *    BUSCA GLOBAL  uma caixa só, procura em TODAS as dimensões ao mesmo
 *                  tempo e devolve agrupado por onde achou. Quem digita
 *                  "pão" não sabe (nem precisa saber) se pão é produto ou
 *                  categoria — e aqui descobre que é os dois.
 *
 *    AÇÕES         aparecem só quando há seleção. Nada de botão morto
 *                  ocupando espaço nobre no topo da coluna.
 *
 *    CAIXAS        uma por dimensão, empilhadas, cada uma com busca
 *                  própria, tri-estado e o valor de cada item. É a lista
 *                  inteira na tela, não um menu que abre e fecha.
 *
 *  DECISÃO QUE MANDA NO RESTO DO ARQUIVO: a lista do filtro usa SEMPRE o
 *  skip (`pularPropria = true`), em qualquer modo de leitura.
 *
 *  Sem isso, no modo Foco, a caixa de Categoria com uma categoria
 *  selecionada mostraria só ela — e não haveria como marcar a segunda. Uma
 *  caixa de filtro que esconde o que você ainda pode escolher não é filtro:
 *  é um beco. O modo de leitura manda nos gráficos; na caixa de filtro,
 *  não.
 */

/*  Busca sem acento e sem caixa.
 *
 *  Não é capricho: o produto é brasileiro e quem digita no caixa escreve
 *  "pao", "acucar", "feijao". Exigir o acento certo para achar "Pão
 *  Francês" transformaria a busca em adivinhação. NFD separa a letra do
 *  acento e o range ̀-ͯ remove só o acento. */
const semAcento = (s) =>
  String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/*  Teto de itens desenhados por lista.
 *
 *  Hoje a maior dimensão tem 36 valores e isso nunca é atingido. Está aqui
 *  porque um cliente com 20 mil SKUs é cenário normal, e 20 mil botões no
 *  DOM travam a aba — o navegador não avisa, só congela. Em vez de
 *  virtualizar a lista (complexidade que ainda não se paga), corta e diz
 *  que cortou. */
const TETO_LISTA = 300;

/*  Quantas caixas nascem abertas.
 *
 *  Todas abertas com seis dimensões dá uma coluna de três telas de altura,
 *  e a pessoa rola sem achar nada. Todas fechadas esconde a informação e
 *  transforma o painel numa gaveta. As três primeiras são as que o usuário
 *  mais usa (unidade, categoria, produto) e as outras ficam a um clique. */
const ABERTAS_DE_SAIDA = 3;

let ctx = null;              // { M, ROTULO_DIM, medidaAtual, render }
const buscaDe = {};          // texto digitado dentro de cada caixa
const fechada = {};          // dimensões recolhidas pelo usuário
let buscaGlobal = '';
let lateralAberta = false;   // só vale em tela estreita
let focoPendente = null;     // qual campo devolver o cursor após redesenhar

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Leitura                                                             */
/* ------------------------------------------------------------------ */

/*  Itens de uma dimensão, sempre com skip, ordenados para a caixa.
 *
 *  A lista NÃO mostra o valor de cada item, e isso é decisão, não
 *  esquecimento. Três motivos:
 *
 *  1. É redundante — os gráficos à direita já mostram o valor, maiores e
 *     com contexto. Repetir o número numa coluna de 272 px só compete com
 *     o nome pela atenção.
 *  2. É enganoso — com o skip, o valor exibido é "quanto seria se eu
 *     selecionasse só isto", e ninguém lê assim: lê como valor atual.
 *  3. Custa o espaço do nome — "Queijo Mussarela (kg)" vinha truncado para
 *     caber um "R$ 2,2 mi" ao lado.
 *
 *  A ORDEM por tamanho fica: é o que torna a lista útil (o produto grande
 *  no topo) e não custa um pixel. */
function itensDe(dim) {
  const { M } = ctx;
  return M.estado(dim, ctx.medidaAtual(), true).sort((a, b) =>
    //  Selecionado primeiro (é o que a pessoa já decidiu), depois o que
    //  ainda é possível por tamanho, e o excluído por último — mas sempre
    //  presente, porque ver que existe é metade do valor da caixa.
    (b.estado === 'selecionado') - (a.estado === 'selecionado')
    || (a.estado === 'excluido') - (b.estado === 'excluido')
    || b.valor - a.valor
    || a.rotulo.localeCompare(b.rotulo, 'pt-BR'));
}

function filtrar(itens, texto) {
  if (!texto.trim()) return itens;
  const alvo = semAcento(texto.trim());
  return itens.filter((x) => semAcento(x.rotulo).includes(alvo));
}

/** Concordância do botão: "Marcar 1 encontrado" / "Marcar os 3 encontrados". */
function rotuloMarcar(n, buscando) {
  if (!n) return 'Nada para marcar';
  if (n === 1) return `Marcar 1 ${buscando ? 'encontrado' : 'possível'}`;
  return `Marcar os ${n} ${buscando ? 'encontrados' : 'possíveis'}`;
}

/* ------------------------------------------------------------------ */
/* Caixas                                                              */
/* ------------------------------------------------------------------ */

function caixaDe(dim, ordem) {
  const { M, ROTULO_DIM } = ctx;
  const rot = ROTULO_DIM[dim] || dim;
  const sel = M.sel[dim];
  const texto = buscaDe[dim] || '';

  //  Uma caixa com seleção NUNCA fica fechada: esconder um filtro que está
  //  ativo é a forma mais rápida de alguém olhar um número errado e não
  //  entender por quê.
  const aberto = sel.size > 0 || (dim in fechada ? !fechada[dim] : ordem < ABERTAS_DE_SAIDA);

  const cabecalho = `
    <button type="button" class="cx-cab${sel.size ? ' tem-sel' : ''}" data-dobrar="${esc(dim)}"
            aria-expanded="${aberto}">
      <i class="cx-seta" aria-hidden="true"></i>
      <span class="cx-nome">${esc(rot)}</span>
      ${sel.size ? `<span class="cx-conta">${sel.size}</span>` : ''}
    </button>`;

  if (!aberto) return `<section class="caixa">${cabecalho}</section>`;

  const itens = itensDe(dim);
  const achados = filtrar(itens, texto);
  const cortou = achados.length > TETO_LISTA;
  const mostra = cortou ? achados.slice(0, TETO_LISTA) : achados;
  const possiveis = itens.filter((x) => x.estado !== 'excluido').length;
  const aMarcar = achados.filter((x) => x.estado === 'possivel').length;

  //  A busca própria só aparece quando a lista é grande o bastante para
  //  justificar. Numa dimensão de 4 valores (forma de pagamento) o campo
  //  seria mais alto que a lista que ele filtra.
  const temBusca = itens.length > 8;

  const lista = mostra.length
    ? mostra.map((x) => `
      <button type="button" class="cx-item ${x.estado}" data-fdim="${esc(dim)}" data-fcod="${x.codigo}"
              aria-pressed="${x.estado === 'selecionado'}" title="${esc(x.rotulo)}">
        <i class="marca" aria-hidden="true"></i>
        <span class="cx-rot">${esc(x.rotulo)}</span>
      </button>`).join('')
    : `<p class="cx-vazio">Nada para <b>${esc(texto)}</b>.</p>`;

  return `<section class="caixa aberta">
    ${cabecalho}
    <div class="cx-corpo">
      ${temBusca ? `<input type="search" class="cx-busca" data-busca="${esc(dim)}"
             placeholder="Buscar…" value="${esc(texto)}" autocomplete="off" spellcheck="false"
             aria-label="Buscar em ${esc(rot.toLowerCase())}">` : ''}
      <p class="cx-cont">${possiveis} de ${itens.length}${texto ? ` · ${achados.length} na busca` : ''}</p>
      <div class="cx-lista">${lista}</div>
      ${cortou ? `<p class="cx-corte">Mostrando ${TETO_LISTA} de ${achados.length}. Refine a busca.</p>` : ''}
      <div class="cx-acoes">
        <button type="button" data-facao="possiveis" data-fdim2="${esc(dim)}"${aMarcar ? '' : ' disabled'}>${rotuloMarcar(aMarcar, !!texto)}</button>
        ${sel.size ? `<button type="button" data-facao="limpar" data-fdim2="${esc(dim)}">Limpar</button>` : ''}
      </div>
    </div>
  </section>`;
}

export function desenharFiltros() {
  const { M } = ctx;

  $('caixas').innerHTML = M.dims.map((dim, i) => caixaDe(dim, i)).join('');

  const total = M.dims.reduce((s, d) => s + M.sel[d].size, 0);
  const acoes = $('lateral-acoes');
  acoes.hidden = !total;
  acoes.innerHTML = total
    ? `<span>${total} valor${total > 1 ? 'es' : ''} filtrado${total > 1 ? 's' : ''}</span>
       <button type="button" data-facao="tudo">Limpar tudo</button>`
    : '';

  $('abre-cont').textContent = total ? ` ${total}` : '';
  $('abre-filtros').classList.toggle('tem-sel', !!total);

  //  O innerHTML destrói o campo em foco a cada tecla digitada. Devolver o
  //  cursor é obrigatório, não polimento: sem isso a pessoa digita uma
  //  letra e perde o teclado.
  if (focoPendente) {
    const campo = document.querySelector(`[data-busca="${focoPendente}"]`);
    if (campo) { campo.focus(); campo.setSelectionRange(campo.value.length, campo.value.length); }
    focoPendente = null;
  }
}

/* ------------------------------------------------------------------ */
/* Busca global                                                        */
/* ------------------------------------------------------------------ */

function desenharBusca() {
  const caixa = $('busca-res');
  const texto = buscaGlobal.trim();
  if (texto.length < 2) { caixa.hidden = true; caixa.innerHTML = ''; return; }

  const { M, ROTULO_DIM } = ctx;
  const grupos = M.dims.map((dim) => {
    const achados = filtrar(itensDe(dim), texto).slice(0, 6);
    return achados.length ? { dim, achados } : null;
  }).filter(Boolean);

  caixa.hidden = false;
  if (!grupos.length) {
    caixa.innerHTML = `<p class="busca-vazio">Nada encontrado para <b>${esc(texto)}</b> em nenhuma dimensão.</p>`;
    return;
  }

  caixa.innerHTML = grupos.map((g) => `
    <div class="busca-grupo">
      <span class="busca-dim">${esc(ROTULO_DIM[g.dim] || g.dim)}</span>
      <div class="busca-itens">${g.achados.map((x) => `
        <button type="button" class="busca-item ${x.estado}" data-fdim="${esc(g.dim)}" data-fcod="${x.codigo}">
          ${esc(x.rotulo)}
        </button>`).join('')}</div>
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* Lateral em tela estreita                                            */
/* ------------------------------------------------------------------ */

function abrirLateral(sim) {
  lateralAberta = sim;
  $('filtros').classList.toggle('aberta', sim);
  $('veu').hidden = !sim;
  $('abre-filtros').setAttribute('aria-expanded', String(sim));
  document.body.classList.toggle('sem-rolagem', sim);
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

function ligar() {
  document.addEventListener('click', (e) => {
    if (e.target.closest('#abre-filtros')) { abrirLateral(!lateralAberta); return; }
    if (e.target.closest('#fecha-lateral') || e.target.closest('#veu')) { abrirLateral(false); return; }

    const dobrar = e.target.closest('[data-dobrar]');
    if (dobrar) {
      const dim = dobrar.dataset.dobrar;
      const i = ctx.M.dims.indexOf(dim);
      const estavaAberto = dim in fechada ? !fechada[dim] : i < ABERTAS_DE_SAIDA;
      fechada[dim] = estavaAberto;
      desenharFiltros();
      return;
    }

    const item = e.target.closest('[data-fdim][data-fcod]');
    if (item) {
      ctx.M.alternar(item.dataset.fdim, Number(item.dataset.fcod));
      //  Achou na busca global, selecionou: a lista de resultados some.
      //  Ali o gesto é "achar uma coisa específica" e ela já foi achada.
      //  Na caixa da dimensão a lista FICA, porque marcar três categorias
      //  seguidas é o caso normal.
      if (item.classList.contains('busca-item')) {
        buscaGlobal = ''; $('busca-global').value = '';
        desenharBusca();
      }
      ctx.render();
      return;
    }

    const acao = e.target.closest('[data-facao]');
    if (acao) {
      const tipo = acao.dataset.facao;
      if (tipo === 'tudo') {
        ctx.M.limpar();
      } else {
        const dim = acao.dataset.fdim2;
        if (tipo === 'limpar') {
          ctx.M.limpar(dim);
        } else {
          const novos = filtrar(itensDe(dim), buscaDe[dim] || '')
            .filter((x) => x.estado === 'possivel')
            .map((x) => x.codigo);
          if (!novos.length) return;
          //  SOMA ao que já estava marcado, não substitui.
          //
          //  Refinar em duas buscas é o uso normal da caixa: procura "pão",
          //  marca; procura "bolo", marca. Substituindo, a segunda marcação
          //  apagaria a primeira em silêncio — e o usuário só descobriria
          //  olhando o total mudar para menos.
          ctx.M.selecionar(dim, [...new Set([...ctx.M.sel[dim], ...novos])]);
        }
      }
      ctx.render();
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.dataset && e.target.dataset.busca) {
      const dim = e.target.dataset.busca;
      buscaDe[dim] = e.target.value;
      focoPendente = dim;
      desenharFiltros();
    } else if (e.target.id === 'busca-global') {
      buscaGlobal = e.target.value;
      desenharBusca();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (buscaGlobal) { buscaGlobal = ''; $('busca-global').value = ''; desenharBusca(); return; }
      if (lateralAberta) abrirLateral(false);
      return;
    }
    //  Enter na busca global seleciona o primeiro resultado. É o atalho de
    //  quem sabe o que procura: digita "pao", Enter, pronto.
    if (e.key === 'Enter' && e.target.id === 'busca-global') {
      e.preventDefault();
      const primeiro = $('busca-res').querySelector('.busca-item');
      if (primeiro) primeiro.click();
    }
  });
}

/* ------------------------------------------------------------------ */

export function iniciarFiltros(contexto) {
  ctx = contexto;
  ligar();
  desenharFiltros();
}

/** Chamado pelo painel a cada render: os números e o tri-estado mudaram. */
export function atualizarFiltros() {
  desenharFiltros();
  if (buscaGlobal.trim().length >= 2) desenharBusca();
}
