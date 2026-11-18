/* Testes do motor associativo, rodando em Node — sem navegador.
 *
 * O gabarito não é escrito à mão: é o próprio DuckDB. `gabarito.json` sai de
 * `testes/gerar_gabarito.py`, que roda as mesmas perguntas em SQL sobre o dado
 * bruto. Se o motor discordar do banco, o teste quebra.
 *
 * Rodar:  node testes/test_motor.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Motor } from '../app/estatico/motor.js';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');

let passou = 0, falhou = 0;
const casos = [];

function teste(nome, fn) { casos.push([nome, fn]); }

function perto(a, b, tolerancia, o) {
  if (Math.abs(a - b) > tolerancia) {
    throw new Error(`esperava ${b}, veio ${a} (diferença ${Math.abs(a - b).toFixed(4)})${o ? ' — ' + o : ''}`);
  }
}

function igual(a, b, o) {
  if (a !== b) throw new Error(`esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}${o ? ' — ' + o : ''}`);
}

function carregar(negocio) {
  // Cada perfil de acesso tem o seu cubo; o teste usa o de quem vê tudo.
  const base = join(RAIZ, 'dados', 'cubo', negocio, 'todas');
  const cab = JSON.parse(readFileSync(join(base, 'cubo.json'), 'utf8'));
  const bin = readFileSync(join(base, 'cubo.bin'));
  // Node devolve Buffer; o motor quer ArrayBuffer.
  const ab = bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength);
  return new Motor(cab, ab);
}

const GAB = JSON.parse(readFileSync(join(AQUI, 'gabarito.json'), 'utf8'));

/* ---------- totais batem com o banco ---------- */

for (const negocio of Object.keys(GAB)) {
  const g = GAB[negocio];

  teste(`${negocio}: total de receita bate com o DuckDB`, () => {
    const m = carregar(negocio);
    perto(m.total('receita'), g.total_receita, 0.02, 'soma de todas as linhas');
  });

  teste(`${negocio}: total de cupons bate com o DuckDB`, () => {
    const m = carregar(negocio);
    igual(m.total('cupons'), g.total_cupons);
  });

  teste(`${negocio}: receita por categoria bate com o DuckDB`, () => {
    const m = carregar(negocio);
    const i = m.dims.indexOf('categoria');
    const valores = m.porDimensao('categoria', 'receita', false);
    m.rotulos.categoria.forEach((rot, cod) => {
      perto(valores[cod], g.por_categoria[rot], 0.02, `categoria ${rot}`);
    });
    igual(i >= 0, true);
  });

  teste(`${negocio}: filtrar uma unidade bate com o DuckDB`, () => {
    const m = carregar(negocio);
    const cod = m.rotulos.unidade.indexOf(g.unidade_teste);
    igual(cod >= 0, true, `unidade ${g.unidade_teste} existe no dicionário`);
    m.alternar('unidade', cod);
    perto(m.total('receita'), g.receita_da_unidade, 0.02);
  });

  teste(`${negocio}: período bate com o DuckDB`, () => {
    const m = carregar(negocio);
    m.periodo(new Date(g.periodo.de + 'T00:00:00'), new Date(g.periodo.ate + 'T00:00:00'));
    perto(m.total('receita'), g.periodo.receita, 0.02, `${g.periodo.de} a ${g.periodo.ate}`);
  });

  teste(`${negocio}: seleção cruzada (unidade + categoria) bate com o DuckDB`, () => {
    const m = carregar(negocio);
    m.alternar('unidade', m.rotulos.unidade.indexOf(g.cruzada.unidade));
    m.alternar('categoria', m.rotulos.categoria.indexOf(g.cruzada.categoria));
    perto(m.total('receita'), g.cruzada.receita, 0.02);
  });
}

/* ---------- comportamento associativo ---------- */

teste('a dimensão selecionada não se filtra a zero (o "skip")', () => {
  const m = carregar('supermercado');
  const antes = m.porDimensao('categoria', 'receita', true);
  const cod = 0;
  m.alternar('categoria', cod);
  const depois = m.porDimensao('categoria', 'receita', true);
  // Com a própria dimensão excluída da máscara, os números não mudam ao
  // selecionar dentro dela — é o que mantém o gráfico utilizável.
  m.rotulos.categoria.forEach((_, c) => perto(depois[c], antes[c], 0.02, `categoria ${c}`));
});

teste('selecionar dentro de uma dimensão FILTRA as outras', () => {
  const m = carregar('supermercado');
  const total = m.total('receita');
  m.alternar('categoria', 0);
  const parcial = m.porDimensao('unidade', 'receita', true);
  const soma = parcial.reduce((a, b) => a + b, 0);
  igual(soma < total, true, 'selecionar categoria tem que reduzir a receita por unidade');
  igual(soma > 0, true);
});

teste('tri-estado: aparece "excluido", não some da lista', () => {
  const m = carregar('supermercado');
  const completo = m.estado('produto', 'receita').length;
  // Seleciona uma categoria: produtos de outras categorias ficam impossíveis.
  m.alternar('categoria', 0);
  const est = m.estado('produto', 'receita');
  igual(est.length, completo, 'a lista não encolhe — valor impossível continua presente');
  const excluidos = est.filter((x) => x.estado === 'excluido').length;
  const possiveis = est.filter((x) => x.estado === 'possivel').length;
  igual(excluidos > 0, true, 'tem que haver produto excluído ao filtrar categoria');
  igual(possiveis > 0, true, 'e tem que sobrar produto possível');
});

teste('tri-estado: o valor selecionado vem marcado como selecionado', () => {
  const m = carregar('padaria');
  m.alternar('unidade', 1);
  const est = m.estado('unidade', 'receita');
  igual(est[1].estado, 'selecionado');
  igual(est.filter((x) => x.estado === 'selecionado').length, 1);
});

teste('alternar duas vezes volta ao estado inicial', () => {
  const m = carregar('farmacia');
  const antes = m.total('receita');
  m.alternar('produto', 3);
  igual(m.total('receita') < antes, true);
  m.alternar('produto', 3);
  perto(m.total('receita'), antes, 0.001);
});

teste('limpar() devolve o total cheio', () => {
  const m = carregar('padaria');
  const antes = m.total('receita');
  m.alternar('unidade', 0); m.alternar('categoria', 1); m.alternar('produto', 2);
  m.limpar();
  perto(m.total('receita'), antes, 0.001);
});

teste('seleção múltipla na mesma dimensão é OU, não E', () => {
  const m = carregar('supermercado');
  m.alternar('unidade', 0);
  const a = m.total('receita');
  m.alternar('unidade', 1);
  const ab = m.total('receita');
  igual(ab > a, true, 'somar uma segunda unidade tem que aumentar, não zerar');
});

teste('período + seleção se combinam', () => {
  const m = carregar('farmacia');
  const cheio = m.total('receita');
  m.periodoPorDia(0, 30);
  const soPeriodo = m.total('receita');
  igual(soPeriodo < cheio, true);
  m.alternar('unidade', 0);
  igual(m.total('receita') < soPeriodo, true);
});

teste('porDia devolve dias em ordem e sem buraco de soma', () => {
  const m = carregar('padaria');
  m.periodoPorDia(10, 40);
  const { dias, soma } = m.porDia('receita');
  igual(dias.length > 0, true);
  for (let i = 1; i < dias.length; i++) igual(dias[i] > dias[i - 1], true, 'dias em ordem crescente');
  perto(soma.reduce((a, b) => a + b, 0), m.total('receita'), 0.02, 'a soma dos dias é o total');
});

/* ---------- a correção que motivou trocar float por inteiro ---------- */

teste('dinheiro em centavos: a soma fecha com o banco no centavo', () => {
  for (const negocio of Object.keys(GAB)) {
    const m = carregar(negocio);
    perto(m.total('receita'), GAB[negocio].total_receita, 0.011,
      `${negocio}: tolerância de um centavo sobre milhões de reais`);
  }
});

/* ---------- desempenho: a razão de existir o índice ---------- */

teste('seleção em 300 mil linhas responde abaixo de 50 ms', () => {
  const m = carregar('supermercado');
  const t0 = process.hrtime.bigint();
  for (let r = 0; r < 20; r++) {
    m.limpar();
    m.alternar('categoria', r % m.rotulos.categoria.length);
    m.alternar('unidade', r % m.rotulos.unidade.length);
    m.dims.forEach((d) => m.estado(d, 'receita'));
    m.total('receita');
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / 20;
  console.log(`      (${ms.toFixed(1)} ms por ciclo completo de seleção + 4 dimensões)`);
  igual(ms < 50, true, `levou ${ms.toFixed(1)} ms por ciclo`);
});

/* ---------- execução ---------- */

console.log(`\nMotor associativo — ${casos.length} testes\n`);
for (const [nome, fn] of casos) {
  try { fn(); console.log(`  ok   ${nome}`); passou++; }
  catch (e) { console.log(`  FALHA ${nome}\n       ${e.message}`); falhou++; }
}
console.log(`\n${passou} passaram, ${falhou} falharam\n`);
process.exit(falhou ? 1 : 0);
