/*  Barra de filtros com busca.
 *
 *  O painel inteiro já filtra no clique, mas isso só alcança o que está
 *  desenhado: o gráfico de produto mostra os 14 maiores, e o 40º produto
 *  não tem onde ser clicado. É para ele que o filtro existe.
 *
 *  Duas entradas:
 *
 *    BUSCA GLOBAL  uma caixa só, procura em TODAS as dimensões ao mesmo
 *                  tempo e devolve agrupado por onde achou. Quem digita
 *                  "pão" não sabe (nem precisa saber) se pão é produto ou
 *                  categoria — e aqui descobre que é os dois.
 *
 *    PÍLULAS       uma por dimensão, abre a lista com busca própria, o
 *                  tri-estado e o valor de cada item.
 *
 *  DECISÃO QUE MANDA NO RESTO DO ARQUIVO: a lista do filtro usa SEMPRE o
 *  skip (`pularPropria = true`), em qualquer modo de leitura.
 *
 *  Sem isso, no modo Foco, abrir o filtro de Categoria com uma categoria
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

let ctx = null;          // { M, ROTULO_DIM, valorDaMedida, render }
let aberta = null;       // dimensão com o popover aberto
const buscaDe = {};      // texto digitado dentro de cada popover
let buscaGlobal = '';

const $ = (id) => document.getElementById(id);

/* ------------------------------------------------------------------ */
/* Leitura                                                             */
/* ------------------------------------------------------------------ */

/** Itens de uma dimensão, sempre com skip, ordenados para a caixa. */
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
  const palavra = buscando ? 'encontrado' : 'possível';
  if (n === 1) return `Marcar 1 ${palavra}`;
  return `Marcar os ${n} ${buscando ? 'encontrados' : 'possíveis'}`;
}

/* ------------------------------------------------------------------ */
/* Pílulas                                                             */
/* ------------------------------------------------------------------ */

export function desenharFiltros() {
  const { M, ROTULO_DIM } = ctx;

  $('pilulas').innerHTML = M.dims.map((dim) => {
    const sel = M.sel[dim];
    const n = sel.size;
    const rot = ROTULO_DIM[dim] || dim;
    const resumo = n === 0 ? ''
      : n === 1 ? `: ${esc(M.rotulos[dim][[...sel][0]])}`
      : `: ${n} escolhidos`;
    return `<button type="button" class="pilula${n ? ' ativa' : ''}${aberta === dim ? ' aberta' : ''}"
              data-abrir="${esc(dim)}" aria-expanded="${aberta === dim}">
        ${esc(rot)}${resumo}<i class="seta" aria-hidden="true"></i>
      </button>`;
  }).join('');

  const pop = $('pop');
  if (!aberta) { pop.hidden = true; pop.innerHTML = ''; return; }

  const itens = itensDe(aberta);
  const texto = buscaDe[aberta] || '';
  const achados = filtrar(itens, texto);
  const cortou = achados.length > TETO_LISTA;
  const mostra = cortou ? achados.slice(0, TETO_LISTA) : achados;
  const possiveis = itens.filter((x) => x.estado !== 'excluido').length;

  //  Quantos o botão de marcar realmente acrescentaria. Precisa estar aqui
  //  porque o botão desliga quando o número é zero — sem isso, buscar algo
  //  que não existe e clicar em "marcar" chamava `selecionar(dim, [])`, que
  //  LIMPA a dimensão. Um botão que apaga o trabalho de quem clicou quando
  //  não encontra nada é pior que um botão que não faz nada.
  const aMarcar = achados.filter((x) => x.estado === 'possivel').length;

  const lista = mostra.length
    ? mostra.map((x) => `
      <button type="button" class="pop-item ${x.estado}" data-fdim="${esc(aberta)}" data-fcod="${x.codigo}"
              aria-pressed="${x.estado === 'selecionado'}">
        <i class="marca" aria-hidden="true"></i>
        <span class="pop-rot">${esc(x.rotulo)}</span>
        <b class="pop-val">${x.estado === 'excluido' ? '—' : ctx.valorDaMedida(x.valor)}</b>
      </button>`).join('')
    : `<p class="pop-vazio">Nada encontrado para <b>${esc(texto)}</b>.</p>`;

  pop.hidden = false;
  pop.innerHTML = `
    <div class="pop-topo">
      <input type="search" class="pop-busca" id="pop-busca" placeholder="Buscar em ${esc((ctx.ROTULO_DIM[aberta] || aberta).toLowerCase())}…"
             value="${esc(texto)}" autocomplete="off" spellcheck="false">
      <button type="button" class="pop-fechar" data-fechar="1" aria-label="Fechar">✕</button>
    </div>
    <p class="pop-cont">${possiveis} de ${itens.length} possíveis${texto ? ` · ${achados.length} na busca` : ''}</p>
    <div class="pop-lista">${lista}</div>
    ${cortou ? `<p class="pop-corte">Mostrando ${TETO_LISTA} de ${achados.length}. Refine a busca.</p>` : ''}
    <div class="pop-acoes">
      <button type="button" data-facao="possiveis"${aMarcar ? '' : ' disabled'}>${rotuloMarcar(aMarcar, !!texto)}</button>
      <button type="button" data-facao="limpar"${M.sel[aberta].size ? '' : ' disabled'}>Limpar esta</button>
    </div>`;

  //  O popover nasce embaixo da pílula que foi clicada, não no canto.
  //  Com seis pílulas numa linha, abrir sempre à esquerda desconecta a
  //  lista do botão: a pessoa clica em "Produto" e a caixa aparece sob
  //  "Unidade", e por um instante ela não sabe o que está lendo.
  const botao = document.querySelector(`[data-abrir="${aberta}"]`);
  if (botao) {
    const caixa = $('filtros').getBoundingClientRect();
    const b = botao.getBoundingClientRect();
    //  Preso dentro da barra: encostar na borda é melhor que vazar para
    //  fora da tela e virar rolagem horizontal.
    const limite = Math.max(0, caixa.width - pop.offsetWidth);
    pop.style.left = `${Math.min(Math.max(0, b.left - caixa.left), limite)}px`;
  }

  const campo = $('pop-busca');
  if (campo) {
    campo.focus();
    campo.setSelectionRange(campo.value.length, campo.value.length);
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
    const achados = filtrar(itensDe(dim), texto).slice(0, 8);
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
          <b>${x.estado === 'excluido' ? '—' : ctx.valorDaMedida(x.valor)}</b>
        </button>`).join('')}</div>
    </div>`).join('');
}

/* ------------------------------------------------------------------ */
/* Eventos                                                             */
/* ------------------------------------------------------------------ */

function fechar() { aberta = null; desenharFiltros(); }

function ligar() {
  document.addEventListener('click', (e) => {
    const abrir = e.target.closest('[data-abrir]');
    if (abrir) {
      const dim = abrir.dataset.abrir;
      aberta = aberta === dim ? null : dim;
      desenharFiltros();
      return;
    }

    if (e.target.closest('[data-fechar]')) { fechar(); return; }

    const item = e.target.closest('[data-fdim][data-fcod]');
    if (item) {
      ctx.M.alternar(item.dataset.fdim, Number(item.dataset.fcod));
      ctx.render();
      //  O popover fica ABERTO depois do clique, de propósito: marcar três
      //  categorias é o caso normal, e fechar a cada marca obrigaria a
      //  reabrir três vezes. A busca global, ao contrário, fecha — ali o
      //  gesto é "achar uma coisa específica".
      if (item.classList.contains('busca-item')) {
        buscaGlobal = ''; $('busca-global').value = '';
        desenharBusca();
      }
      return;
    }

    const acao = e.target.closest('[data-facao]');
    if (acao && aberta) {
      const dim = aberta;
      if (acao.dataset.facao === 'limpar') {
        ctx.M.limpar(dim);
      } else {
        const texto = buscaDe[dim] || '';
        const novos = filtrar(itensDe(dim), texto)
          .filter((x) => x.estado !== 'excluido')
          .map((x) => x.codigo);
        if (!novos.length) return;
        //  SOMA ao que já estava marcado, não substitui.
        //
        //  Refinar em duas buscas é o uso normal da caixa: procura "pão",
        //  marca; procura "bolo", marca. Substituindo, a segunda marcação
        //  apagaria a primeira em silêncio — e o usuário só descobriria
        //  olhando o total mudar para menos.
        //
        //  `selecionar` troca a seleção inteira de uma vez; passo a união.
        //  Chamar `alternar` em laço daria o mesmo e recalcularia a máscara
        //  a cada item, além de DESmarcar o que já estava marcado.
        ctx.M.selecionar(dim, [...new Set([...ctx.M.sel[dim], ...novos])]);
      }
      ctx.render();
      return;
    }

    //  Clique fora fecha. O teste é pelo container inteiro, não pelo
    //  popover: clicar na própria pílula já é tratado acima, e clicar na
    //  barra (no espaço vazio entre pílulas) não deve fechar.
    if (aberta && !e.target.closest('#filtros')) fechar();
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'pop-busca') {
      buscaDe[aberta] = e.target.value;
      desenharFiltros();
    } else if (e.target.id === 'busca-global') {
      buscaGlobal = e.target.value;
      desenharBusca();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (aberta) { fechar(); return; }
      if (buscaGlobal) { buscaGlobal = ''; $('busca-global').value = ''; desenharBusca(); }
      return;
    }
    //  Enter na busca global seleciona o primeiro resultado. É o atalho de
    //  quem sabe o que procura: digita "pao", Enter, pronto.
    if (e.key === 'Enter' && e.target.id === 'busca-global') {
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
