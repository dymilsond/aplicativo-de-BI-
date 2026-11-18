"""Gera a base de dado fictícia de um negócio do catálogo.

O dado não é aleatório puro: respeita hora do dia, dia da semana,
sazonalidade do ano, porte de cada loja e giro de cada produto. É o que faz
o gráfico ter cara de negócio de verdade em vez de ruído.

Tabelas geradas (mesma forma nos três ramos, para o chassi servir a todos):

    venda    — movimento item a item, com hora, cupom e forma de pagamento
    estoque  — posição atual por produto/loja, com validade e mínimo
    caixa    — fluxo financeiro diário: entradas e saídas por categoria
"""

from __future__ import annotations

import csv
import os
import random
import tempfile
from datetime import date, timedelta
from pathlib import Path

import duckdb

from clientes.catalogo import NEGOCIOS, Negocio

#: Dois anos de histórico. É o mínimo para enxergar sazonalidade de verdade.
DIAS_DE_HISTORICO = 730

DIRETORIO_DADOS = Path(__file__).resolve().parent.parent / "dados"


def caminho_do_banco(chave: str) -> Path:
    return DIRETORIO_DADOS / f"{chave}.duckdb"


# ---------------------------------------------------------------------------
# Curvas e ruído
# ---------------------------------------------------------------------------


def _tendencia(dia: date, inicio: date, ao_ano: float) -> float:
    """Crescimento (ou queda) suave ao longo do tempo."""
    anos = (dia - inicio).days / 365.0
    return (1.0 + ao_ano) ** anos


def _ruido(rng: random.Random, intensidade: float = 0.18) -> float:
    """Variação do dia a dia. Nunca negativa."""
    return max(0.05, rng.gauss(1.0, intensidade))


def _feriado_fraco(dia: date) -> float:
    """Dias em que quase todo comércio de bairro cai."""
    marcos = {(1, 1), (12, 25), (12, 31), (9, 7), (11, 2), (11, 15), (5, 1)}
    return 0.25 if (dia.month, dia.day) in marcos else 1.0


# ---------------------------------------------------------------------------
# Geração
# ---------------------------------------------------------------------------


def _gerar_vendas(negocio: Negocio, rng: random.Random, inicio: date, fim: date):
    """Movimento de venda, item a item, agrupado por cupom."""
    linhas: list[tuple] = []
    formas = [f for f, _ in negocio.formas_pagamento]
    pesos_forma = [p for _, p in negocio.formas_pagamento]
    produtos = list(negocio.produtos)
    pesos_giro = [p.giro for p in produtos]
    hora_ini, hora_fim = negocio.expediente

    cupom = 0
    dia = inicio
    while dia <= fim:
        peso_dia = (
            negocio.curva_semana[dia.weekday()]
            * negocio.curva_mes[dia.month]
            * _tendencia(dia, inicio, 0.08)
            * _feriado_fraco(dia)
            * _ruido(rng, 0.12)
        )
        # Começo do mês vende mais: salário caiu na conta.
        if dia.day <= 7:
            peso_dia *= 1.18
        elif dia.day >= 25:
            peso_dia *= 0.88

        for unidade in negocio.unidades:
            peso_unidade = peso_dia * negocio.porte[unidade]

            for hora in range(hora_ini, hora_fim + 1):
                peso_hora = negocio.curva_hora.get(hora, 0.5)
                # Número de cupons naquela hora, naquela loja.
                cupons = max(0, int(rng.gauss(6 * peso_unidade * peso_hora, 2)))

                for _ in range(cupons):
                    cupom += 1
                    forma = rng.choices(formas, weights=pesos_forma, k=1)[0]
                    minimo, maximo = negocio.itens_por_cupom
                    n_itens = rng.randint(minimo, maximo)
                    escolhidos = rng.choices(produtos, weights=pesos_giro, k=n_itens)

                    for produto in set(escolhidos):
                        qtd = escolhidos.count(produto)
                        if produto.categoria in ("Hortifruti", "Açougue") or "(kg)" in produto.nome:
                            qtd = round(qtd * rng.uniform(0.4, 2.2), 2)
                        # Promoção ocasional corrói a margem — de propósito.
                        desconto = 0.82 if rng.random() < 0.06 else 1.0
                        receita = round(produto.preco * qtd * desconto, 2)
                        custo = round(produto.custo * qtd, 2)
                        linhas.append(
                            (
                                dia, hora, unidade, produto.categoria, produto.nome,
                                qtd, receita, custo, forma, f"C{cupom:08d}",
                                produto.controlado,
                            )
                        )
        dia += timedelta(days=1)
    return linhas


def _gerar_estoque(negocio: Negocio, rng: random.Random, hoje: date):
    """Posição de estoque de hoje, com validade e mínimo por produto."""
    linhas: list[tuple] = []
    for unidade in negocio.unidades:
        porte = negocio.porte[unidade]
        for produto in negocio.produtos:
            # Cobertura-alvo: quantos dias de venda o estoque deveria cobrir.
            cobertura_alvo = 12 if produto.validade_dias is None else min(
                12, max(2, produto.validade_dias // 3)
            )
            venda_dia = produto.giro * 6 * porte
            minimo = round(venda_dia * max(2, cobertura_alvo / 3), 1)

            # Alguns produtos ficam abaixo do mínimo (ruptura) de propósito,
            # outros ficam encalhados muito acima.
            sorte = rng.random()
            if sorte < 0.12:
                qtd = round(venda_dia * rng.uniform(0.0, 1.5), 1)       # ruptura
            elif sorte < 0.24:
                qtd = round(venda_dia * cobertura_alvo * rng.uniform(2.5, 5.0), 1)  # encalhe
            else:
                qtd = round(venda_dia * cobertura_alvo * rng.uniform(0.7, 1.6), 1)

            if produto.validade_dias is None:
                validade = None
            else:
                # Perecível curto vence logo; alguns lotes já estão no limite.
                restante = rng.uniform(0.05, 1.0) * produto.validade_dias
                if rng.random() < 0.15:
                    restante = rng.uniform(-5, 20)  # vencido ou quase
                validade = hoje + timedelta(days=int(restante))

            linhas.append(
                (
                    hoje, unidade, produto.categoria, produto.nome, qtd,
                    produto.custo, validade, minimo, produto.controlado,
                )
            )
    return linhas


def _gerar_caixa(negocio: Negocio, rng: random.Random, vendas_por_dia: dict, inicio: date, fim: date):
    """Fluxo financeiro: a entrada vem da venda, a saída vem das despesas."""
    linhas: list[tuple] = []
    dia = inicio
    while dia <= fim:
        for unidade in negocio.unidades:
            porte = negocio.porte[unidade]
            receita = vendas_por_dia.get((dia, unidade), 0.0)
            if receita:
                linhas.append((dia, unidade, "Entrada", "Venda do dia", round(receita, 2)))

            # Despesa fixa mensal rateada: lança no dia correspondente.
            for nome, valor_mes in negocio.despesas:
                dia_lancamento = (abs(hash(nome)) % 26) + 2
                if dia.day == dia_lancamento:
                    valor = valor_mes * porte * rng.uniform(0.92, 1.1)
                    # Fornecedor acompanha o movimento do mês anterior.
                    if "Fornecedor" in nome:
                        valor *= negocio.curva_mes[dia.month] * 0.95
                    linhas.append((dia, unidade, "Saída", nome, -round(valor, 2)))

            # Despesa eventual.
            if rng.random() < 0.04:
                nome = rng.choice(
                    ["Conserto de equipamento", "Compra emergencial", "Material de escritório",
                     "Taxa de cartão extra", "Uniforme", "Treinamento"]
                )
                linhas.append((dia, unidade, "Saída", nome, -round(rng.uniform(180, 2600) * porte, 2)))
        dia += timedelta(days=1)
    return linhas


def _carregar(con: duckdb.DuckDBPyConnection, tabela: str, linhas: list[tuple]) -> None:
    """Insere em massa via CSV + COPY.

    `executemany` com centenas de milhares de linhas leva minutos; o `COPY`
    do DuckDB leva segundos. Medido: ~380 mil linhas passaram de 4 minutos
    sem fim à vista para menos de 3 segundos.
    """
    if not linhas:
        return

    with tempfile.NamedTemporaryFile(
        "w", suffix=".csv", delete=False, newline="", encoding="utf-8"
    ) as saida:
        escritor = csv.writer(saida)
        for linha in linhas:
            escritor.writerow(["" if v is None else v for v in linha])
        temporario = saida.name

    try:
        # O caminho vai como parâmetro preparado — nunca concatenado no SQL.
        con.execute(
            f"COPY {tabela} FROM ? (FORMAT CSV, HEADER false, NULLSTR '')",
            [temporario],
        )
    finally:
        try:
            os.unlink(temporario)
        except OSError:
            pass


def gerar(chave: str, semente: int = 42) -> Path:
    """Cria o banco do negócio. Apaga e refaz se já existir."""
    negocio = NEGOCIOS[chave]
    rng = random.Random(semente)

    hoje = date.today()
    inicio = hoje - timedelta(days=DIAS_DE_HISTORICO)

    DIRETORIO_DADOS.mkdir(parents=True, exist_ok=True)
    destino = caminho_do_banco(chave)
    if destino.exists():
        destino.unlink()

    con = duckdb.connect(str(destino))
    con.execute(
        """
        CREATE TABLE venda (
            data            DATE,
            hora            INTEGER,
            unidade         VARCHAR,
            categoria       VARCHAR,
            produto         VARCHAR,
            quantidade      DECIMAL(10,2),
            receita         DECIMAL(12,2),
            custo           DECIMAL(12,2),
            forma_pagamento VARCHAR,
            cupom           VARCHAR,
            controlado      BOOLEAN
        )
        """
    )
    con.execute(
        """
        CREATE TABLE estoque (
            data            DATE,
            unidade         VARCHAR,
            categoria       VARCHAR,
            produto         VARCHAR,
            quantidade      DECIMAL(12,2),
            custo_unitario  DECIMAL(12,2),
            validade        DATE,
            estoque_minimo  DECIMAL(12,2),
            controlado      BOOLEAN
        )
        """
    )
    con.execute(
        """
        CREATE TABLE caixa (
            data      DATE,
            unidade   VARCHAR,
            tipo      VARCHAR,
            categoria VARCHAR,
            valor     DECIMAL(12,2)
        )
        """
    )

    vendas = _gerar_vendas(negocio, rng, inicio, hoje)
    _carregar(con, "venda", vendas)

    por_dia: dict[tuple, float] = {}
    for linha in vendas:
        chave_dia = (linha[0], linha[2])
        por_dia[chave_dia] = por_dia.get(chave_dia, 0.0) + float(linha[6])

    _carregar(con, "estoque", _gerar_estoque(negocio, rng, hoje))
    _carregar(con, "caixa", _gerar_caixa(negocio, rng, por_dia, inicio, hoje))

    resumo = con.execute(
        "SELECT (SELECT count(*) FROM venda), (SELECT count(*) FROM estoque), "
        "(SELECT count(*) FROM caixa), (SELECT round(sum(receita)/1000000, 2) FROM venda)"
    ).fetchone()
    con.close()

    print(
        f"{negocio.nome:28} → {resumo[0]:>7} vendas | {resumo[1]:>4} estoque | "
        f"{resumo[2]:>5} caixa | R$ {resumo[3]} mi faturados"
    )
    return destino


def gerar_todos() -> None:
    for chave in NEGOCIOS:
        gerar(chave)


if __name__ == "__main__":
    gerar_todos()
