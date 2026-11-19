/* Motor associativo: seleção propagando por tudo, no navegador.

   Herda o desenho do painel de Gestão de Pessoas do Cade — dicionário de
   valores, código inteiro, array tipado — e muda a parte que lá era o teto:

   LÁ: cada gráfico varre as N linhas chamando um predicado. Com 13 gráficos e
       94 mil linhas, são ~1,2 milhão de avaliações por clique. Funciona
       naquele volume; não funciona em 300 mil linhas.

   AQUI: cada valor de cada dimensão tem um bitmap das linhas em que aparece.
       A seleção vira AND de bitmaps — 32 linhas por operação de 32 bits — e o
       custo passa a depender do tamanho da seleção, não do total de linhas.

   E o período não usa bitmap nenhum: as linhas vêm ordenadas por data do
   servidor, então filtrar por data é achar dois índices por busca binária e
   trabalhar na fatia entre eles. Um bitmap por dia (731 valores) custaria
   mais memória que o cubo inteiro.

   ## Tri-estado

   O Qlik mostra três coisas, e é o que faz o usuário aprender a estrutura do
   próprio dado: selecionado, possível e **excluído** (cinza). Excluído é o
   valor que existe na base mas não sobrevive à seleção atual. Esconder esse
   valor, em vez de acinzentá-lo, é esconder do usuário que ele existe.

   `estado(dim)` devolve os três, sempre — nunca omite valor.
*/

const PALAVRA = 32;

function palavras(n) { return (n + PALAVRA - 1) >> 5; }

/* ---------- operações de bitmap ---------- */

function bmVazio(n) { return new Uint32Array(palavras(n)); }

function bmMarcar(bm, i) { bm[i >> 5] |= (1 << (i & 31)); }

function bmTem(bm, i) { return (bm[i >> 5] & (1 << (i & 31))) !== 0; }

function bmOu(destino, origem) {
  for (let w = 0; w < destino.length; w++) destino[w] |= origem[w];
  return destino;
}

function bmE(destino, origem) {
  for (let w = 0; w < destino.length; w++) destino[w] &= origem[w];
  return destino;
}

function bmCheio(n) {
  const bm = new Uint32Array(palavras(n)).fill(0xffffffff);
  const sobra = n & 31;                       // zera os bits além da última linha
  if (sobra) bm[bm.length - 1] = (1 << sobra) - 1;
  return bm;
}

/* ---------- leitura do cubo binário ---------- */

const TIPOS = { u8: Uint8Array, u16: Uint16Array, u32: Uint32Array, f32: Float32Array };

function lerBloco(buffer, bloco) {
  const Tipo = TIPOS[bloco.tipo];
  if (!Tipo) throw new Error(`Tipo de bloco desconhecido: ${bloco.tipo}`);
  // slice (e não subarray) porque o início do bloco pode não estar alinhado
  // ao tamanho do tipo, e aí o construtor de array tipado recusa a view.
  return new Tipo(buffer.slice(bloco.inicio, bloco.inicio + bloco.bytes));
}

export class Motor {
  constructor(cabecalho, buffer) {
    this.cab = cabecalho;
    this.n = cabecalho.linhas;
    this.origem = new Date(cabecalho.origem + 'T00:00:00');

    const porNome = {};
    cabecalho.blocos.forEach((b) => { porNome[b.nome] = lerBloco(buffer, b); });
    this.blocos = porNome;

    this.data = porNome.data;                       // dias desde a origem, ordenado
    this.dims = cabecalho.dimensoes.map((d) => d.nome);
    this.rotulos = {};                              // dim -> valores legíveis
    this.cols = {};                                 // dim -> códigos por linha
    cabecalho.dimensoes.forEach((d) => {
      this.rotulos[d.nome] = d.valores;
      this.cols[d.nome] = porNome[d.nome];
    });

    this.medidas = {};                              // medida -> {valores, escala}
    cabecalho.medidas.forEach((m) => {
      this.medidas[m.nome] = { valores: porNome[m.nome], escala: m.escala };
    });

    this.indice = {};                               // dim -> [bitmap por código]
    this.dims.forEach((d) => { this.indice[d] = this._indexar(d); });

    this.sel = {};                                  // dim -> Set de códigos
    this.dims.forEach((d) => { this.sel[d] = new Set(); });

    this.de = 0;                                    // fatia de período, em índices de linha
    this.ate = this.n;
    this._cacheMascara = null;
  }

  static async carregar(base) {
    const [cab, bin] = await Promise.all([
      fetch(`${base}/cubo.json`).then((r) => r.json()),
      fetch(`${base}/cubo.bin`).then((r) => r.arrayBuffer()),
    ]);
    return new Motor(cab, bin);
  }

  _indexar(dim) {
    const col = this.cols[dim], qtd = this.rotulos[dim].length;
    const bms = Array.from({ length: qtd }, () => bmVazio(this.n));
    for (let i = 0; i < this.n; i++) bmMarcar(bms[col[i]], i);
    return bms;
  }

  /* ---------- período ---------- */

  /** Primeira linha com data >= dia (busca binária: a coluna está ordenada). */
  _primeiro(dia) {
    let lo = 0, hi = this.n;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.data[m] < dia) lo = m + 1; else hi = m; }
    return lo;
  }

  /** Define o período em dias desde a origem do cubo. `ate` é inclusivo. */
  periodoPorDia(de, ate) {
    this.de = this._primeiro(de);
    this.ate = this._primeiro(ate + 1);
    this._cacheMascara = null;
    return this;
  }

  periodo(dataDe, dataAte) {
    const dia = (d) => Math.round((d - this.origem) / 86400000);
    return this.periodoPorDia(dia(dataDe), dia(dataAte));
  }

  /** Data da linha, como objeto Date. */
  dataDa(i) { return new Date(this.origem.getTime() + this.data[i] * 86400000); }

  get ultimoDia() { return this.n ? this.data[this.n - 1] : 0; }

  diaDaData(d) { return Math.round((d - this.origem) / 86400000); }

  /* ---------- seleção ---------- */

  alternar(dim, codigo) {
    const s = this.sel[dim];
    if (s.has(codigo)) s.delete(codigo); else s.add(codigo);
    this._cacheMascara = null;
    return this;
  }

  selecionar(dim, codigos) {
    this.sel[dim] = new Set(codigos);
    this._cacheMascara = null;
    return this;
  }

  limpar(dim) {
    if (dim) this.sel[dim].clear();
    else this.dims.forEach((d) => this.sel[d].clear());
    this._cacheMascara = null;
    return this;
  }

  get temSelecao() { return this.dims.some((d) => this.sel[d].size > 0); }

  /** As seleções ativas, prontas para virar chips na tela. */
  selecoes() {
    const fora = [];
    this.dims.forEach((d) => {
      if (this.sel[d].size) {
        fora.push({
          dim: d,
          codigos: [...this.sel[d]],
          rotulos: [...this.sel[d]].map((c) => this.rotulos[d][c]),
        });
      }
    });
    return fora;
  }

  /* ---------- máscaras ---------- */

  /** Bitmap das linhas que sobrevivem à seleção, ignorando a dimensão dada.
   *
   *  Ignorar a própria dimensão é o que impede um gráfico de se filtrar a
   *  zero quando o usuário clica nele — mesmo papel do `skip` do painel do
   *  Cade, mas feito com bitmap em vez de varredura.
   */
  mascara(excluindo) {
    const ativas = this.dims.filter((d) => d !== excluindo && this.sel[d].size);
    if (!ativas.length) {
      // Nada selecionado fora dessa dimensão: toda linha do período vale.
      // Devolver `null` evita alocar e deixa o chamador andar direto na fatia.
      return null;
    }
    if (!excluindo && this._cacheMascara) return this._cacheMascara;

    let acc = null;
    for (const d of ativas) {
      const codigos = [...this.sel[d]];
      let uniao = bmVazio(this.n);
      for (const c of codigos) bmOu(uniao, this.indice[d][c]);
      acc = acc === null ? uniao : bmE(acc, uniao);
    }
    if (!excluindo) this._cacheMascara = acc;
    return acc;
  }

  /* ---------- agregação ---------- */

  /** Percorre as linhas vivas somando a medida.
   *
   *  **Só visita linha que está na seleção.** A primeira versão andava de
   *  `de` a `ate` perguntando `bmTem(i)` a cada índice — e aí o bitmap não
   *  comprava nada, porque o custo continuava sendo o total de linhas.
   *  Medido na época: 1,1x contra a varredura simples, ou seja, nada.
   *
   *  Aqui o laço anda de palavra em palavra: palavra zerada pula 32 linhas de
   *  uma vez, e dentro da palavra só os bits ligados são extraídos
   *  (`bits & -bits` isola o menos significativo). O custo passa a ser
   *  proporcional ao tamanho da seleção, que era a promessa do índice.
   */
  _somar(mascara, medida, destino, chaveDe) {
    const m = this.medidas[medida];
    if (!m) throw new Error(`Medida desconhecida: ${medida}`);
    const v = m.valores;
    let total = 0;

    if (mascara === null) {
      for (let i = this.de; i < this.ate; i++) {
        total += v[i];
        if (destino) destino[chaveDe(i)] += v[i];
      }
      return total;
    }
    if (this.ate <= this.de) return 0;

    const wIni = this.de >> 5, wFim = (this.ate - 1) >> 5;
    const cortaIni = this.de & 31, cortaFim = this.ate & 31;

    for (let w = wIni; w <= wFim; w++) {
      let bits = mascara[w];
      if (!bits) continue;                                  // pula 32 linhas
      if (w === wIni && cortaIni) bits &= (0xffffffff << cortaIni);
      if (w === wFim && cortaFim) bits &= ~(0xffffffff << cortaFim);
      const base = w << 5;
      while (bits) {
        const menor = bits & -bits;                         // isola o bit mais baixo
        const i = base + (31 - Math.clz32(menor));
        total += v[i];
        if (destino) destino[chaveDe(i)] += v[i];
        bits ^= menor;
      }
    }
    return total;
  }

  /** Total de uma medida sob a seleção atual, já na escala de leitura. */
  total(medida) {
    return this._somar(this.mascara(null), medida, null, null) / this.medidas[medida].escala;
  }

  /** Soma da medida por valor de uma dimensão. Devolve array por código. */
  porDimensao(dim, medida, excluindoSelecaoPropria) {
    const col = this.cols[dim];
    const acc = new Float64Array(this.rotulos[dim].length);
    const m = this.mascara(excluindoSelecaoPropria ? dim : null);
    this._somar(m, medida, acc, (i) => col[i]);
    const escala = this.medidas[medida].escala;
    if (escala !== 1) for (let k = 0; k < acc.length; k++) acc[k] /= escala;
    return acc;
  }

  /** Tri-estado de uma dimensão: selecionado, possível e **excluído**.
   *
   *  Nunca omite valor. O que não sobrevive à seleção volta com
   *  `estado: 'excluido'` e valor zero, para a tela poder acinzentar em vez
   *  de sumir — é assim que o usuário descobre o que existe na base.
   */
  estado(dim, medida, pularPropria = true) {
    //  `pularPropria` = o "skip". Com ele ligado (padrão), a dimensão é
    //  excluída da própria máscara: selecionar dentro dela não muda os
    //  números dela. Desligado, a dimensão se filtra a si mesma e sobra só
    //  o selecionado — que é o comportamento de uma ferramenta de BI
    //  comum. Quem decide é a tela, não o motor.
    const valores = this.porDimensao(dim, medida || this.cab.medidas[0].nome, pularPropria);
    const sel = this.sel[dim];
    return this.rotulos[dim].map((rotulo, codigo) => ({
      codigo,
      rotulo,
      valor: valores[codigo],
      estado: sel.has(codigo) ? 'selecionado' : valores[codigo] > 0 ? 'possivel' : 'excluido',
    }));
  }

  /** Série temporal: soma da medida por dia, dentro do período e da seleção. */
  porDia(medida) {
    const m = this.mascara(null), v = this.medidas[medida].valores, escala = this.medidas[medida].escala;
    const dias = [], soma = [];
    let diaAtual = -1;
    // Mesmo motivo do `_somar`: anda pelos bits ligados, não por todo índice.
    // As linhas estão ordenadas por data, então os dias saem em ordem sozinhos.
    const visitar = (i) => {
      const d = this.data[i];
      if (d !== diaAtual) { dias.push(d); soma.push(0); diaAtual = d; }
      soma[soma.length - 1] += v[i];
    };
    if (m === null) {
      for (let i = this.de; i < this.ate; i++) visitar(i);
    } else if (this.ate > this.de) {
      const wIni = this.de >> 5, wFim = (this.ate - 1) >> 5;
      const cortaIni = this.de & 31, cortaFim = this.ate & 31;
      for (let w = wIni; w <= wFim; w++) {
        let bits = m[w];
        if (!bits) continue;
        if (w === wIni && cortaIni) bits &= (0xffffffff << cortaIni);
        if (w === wFim && cortaFim) bits &= ~(0xffffffff << cortaFim);
        const base = w << 5;
        while (bits) { const menor = bits & -bits; visitar(base + (31 - Math.clz32(menor))); bits ^= menor; }
      }
    }
    if (escala !== 1) for (let k = 0; k < soma.length; k++) soma[k] /= escala;
    return { dias, soma };
  }

  /** Quantas linhas do cubo sobrevivem à seleção — só para diagnóstico. */
  linhasAtivas() {
    const m = this.mascara(null);
    if (m === null) return this.ate - this.de;
    let c = 0;
    for (let i = this.de; i < this.ate; i++) if (bmTem(m, i)) c++;
    return c;   // diagnóstico, roda raro: não vale complicar
  }
}

export const _interno = { bmVazio, bmCheio, bmMarcar, bmTem, bmOu, bmE, palavras };
