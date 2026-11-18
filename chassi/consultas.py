"""Todas as consultas do aplicativo.

Nenhuma delas toca a tabela crua: todas leem `base_venda`, `base_estoque` e
`base_caixa`, que `chassi.seguranca.consultar()` monta já reduzidas para o
usuário da sessão. Quem escrever `FROM venda` aqui recebe exceção, não dado.

As três tabelas têm a mesma forma nos três ramos — é isso que faz o mesmo
conjunto de telas servir padaria, supermercado e farmácia.
"""

from __future__ import annotations

from datetime import date, timedelta

from chassi.seguranca import Usuario, consultar, um

# ---------------------------------------------------------------------------
# PRESENTE — o que está acontecendo hoje e neste mês
# ---------------------------------------------------------------------------


def kpis_de_hoje(usuario: Usuario) -> dict:
    """Receita, cupons, ticket e margem de hoje contra a média recente.

    A comparação é o que dá sentido ao número: "R$ 4.200" não diz nada;
    "R$ 4.200, 12% acima da média das últimas 4 semanas" diz tudo.
    """
    return um(
        usuario,
        """
        SELECT
            coalesce(sum(CASE WHEN data = current_date THEN receita END), 0)      AS receita_hoje,
            coalesce(sum(CASE WHEN data = current_date THEN receita - custo END), 0) AS margem_hoje,
            count(DISTINCT CASE WHEN data = current_date THEN cupom END)          AS cupons_hoje,
            coalesce(sum(CASE WHEN data >= current_date - 28 AND data < current_date
                              THEN receita END), 0) / 28.0                        AS receita_media,
            coalesce(count(DISTINCT CASE WHEN data >= current_date - 28 AND data < current_date
                              THEN cupom END), 0) / 28.0                          AS cupons_media
        FROM base_venda
        WHERE data >= current_date - 28
        """,
    )


def kpis_do_mes(usuario: Usuario) -> dict:
    """Mês corrente contra o mesmo período do mês passado — comparação justa."""
    return um(
        usuario,
        """
        SELECT
            coalesce(sum(CASE WHEN data >= date_trunc('month', current_date)
                              THEN receita END), 0)                  AS receita_mes,
            coalesce(sum(CASE WHEN data >= date_trunc('month', current_date)
                              THEN receita - custo END), 0)          AS margem_mes,
            coalesce(sum(CASE WHEN data >= date_trunc('month', current_date) - INTERVAL 1 MONTH
                               AND data <  date_trunc('month', current_date)
                               AND day(data) <= day(current_date)
                              THEN receita END), 0)                  AS receita_mes_passado
        FROM base_venda
        WHERE data >= date_trunc('month', current_date) - INTERVAL 1 MONTH
        """,
    )


def movimento_por_hora(usuario: Usuario) -> list[dict]:
    """Curva do dia: hoje contra a média das últimas 4 semanas, hora a hora."""
    return consultar(
        usuario,
        """
        SELECT
            hora,
            coalesce(sum(CASE WHEN data = current_date THEN receita END), 0) AS hoje,
            coalesce(sum(CASE WHEN data >= current_date - 28 AND data < current_date
                              THEN receita END), 0) / 28.0                   AS media
        FROM base_venda
        WHERE data >= current_date - 28
        GROUP BY hora
        ORDER BY hora
        """,
    )


def receita_por_unidade_hoje(usuario: Usuario) -> list[dict]:
    return consultar(
        usuario,
        """
        SELECT unidade,
               sum(receita)              AS receita,
               sum(receita - custo)      AS margem,
               count(DISTINCT cupom)     AS cupons
        FROM base_venda
        WHERE data = current_date
        GROUP BY unidade
        ORDER BY receita DESC
        """,
    )


# ---------------------------------------------------------------------------
# PASSADO — histórico, sazonalidade e o que o olho não pega
# ---------------------------------------------------------------------------


def receita_mensal(usuario: Usuario, meses: int = 24, so_fechados: bool = True) -> list[dict]:
    """Faturamento mês a mês.

    `so_fechados` exclui o mês corrente, que ainda está pela metade. Sem isso,
    **toda** série termina com um despencar falso — o gráfico mostraria uma
    queda que não existe, e o dono tomaria decisão em cima dela.
    """
    corte = "AND data < date_trunc('month', current_date)" if so_fechados else ""
    return consultar(
        usuario,
        f"""
        SELECT date_trunc('month', data)  AS mes,
               sum(receita)               AS receita,
               sum(receita - custo)       AS margem,
               count(DISTINCT cupom)      AS cupons
        FROM base_venda
        WHERE data >= date_trunc('month', current_date) - INTERVAL (?) MONTH
          {corte}
        GROUP BY 1
        ORDER BY 1
        """,
        params=(meses,),
    )


def receita_por_categoria(usuario: Usuario, dias: int = 90) -> list[dict]:
    return consultar(
        usuario,
        """
        SELECT categoria,
               sum(receita)                                      AS receita,
               sum(receita - custo)                              AS margem,
               100.0 * sum(receita - custo) / nullif(sum(receita), 0) AS margem_pct
        FROM base_venda
        WHERE data >= current_date - (?)
        GROUP BY categoria
        ORDER BY receita DESC
        """,
        params=(dias,),
    )


def receita_por_dia_da_semana(usuario: Usuario, dias: int = 180) -> list[dict]:
    """Qual dia realmente fatura mais. Quase sempre surpreende o dono."""
    return consultar(
        usuario,
        """
        SELECT dayofweek(data) AS num,
               CASE dayofweek(data)
                 WHEN 0 THEN 'Domingo'  WHEN 1 THEN 'Segunda' WHEN 2 THEN 'Terça'
                 WHEN 3 THEN 'Quarta'   WHEN 4 THEN 'Quinta'  WHEN 5 THEN 'Sexta'
                 ELSE 'Sábado' END                      AS dia,
               sum(receita) / count(DISTINCT data)      AS receita_media
        FROM base_venda
        WHERE data >= current_date - (?)
        GROUP BY 1, 2
        ORDER BY 1
        """,
        params=(dias,),
    )


def top_produtos(usuario: Usuario, dias: int = 90, limite: int = 12) -> list[dict]:
    return consultar(
        usuario,
        """
        SELECT produto, categoria,
               sum(quantidade)                                        AS quantidade,
               sum(receita)                                           AS receita,
               sum(receita - custo)                                   AS margem,
               100.0 * sum(receita - custo) / nullif(sum(receita), 0) AS margem_pct
        FROM base_venda
        WHERE data >= current_date - (?)
        GROUP BY produto, categoria
        ORDER BY receita DESC
        LIMIT (?)
        """,
        params=(dias, limite),
    )


def vilaes_de_margem(usuario: Usuario, dias: int = 90, limite: int = 8) -> list[dict]:
    """Produtos que vendem muito e dão pouca margem.

    É a consulta que mais vende o serviço: o dono conhece o campeão de venda,
    não conhece o campeão de venda que não dá lucro.
    """
    return consultar(
        usuario,
        """
        WITH p AS (
            SELECT produto, categoria,
                   sum(receita)                                           AS receita,
                   sum(receita - custo)                                   AS margem,
                   100.0 * sum(receita - custo) / nullif(sum(receita), 0)  AS margem_pct
            FROM base_venda
            WHERE data >= current_date - (?)
            GROUP BY produto, categoria
        )
        SELECT * FROM p
        WHERE receita >= (SELECT quantile_cont(receita, 0.5) FROM p)
        ORDER BY margem_pct ASC
        LIMIT (?)
        """,
        params=(dias, limite),
    )


def comparativo_de_unidades(usuario: Usuario, meses: int = 12) -> list[dict]:
    return consultar(
        usuario,
        """
        SELECT date_trunc('month', data) AS mes, unidade, sum(receita) AS receita
        FROM base_venda
        WHERE data >= date_trunc('month', current_date) - INTERVAL (?) MONTH
        GROUP BY 1, 2
        ORDER BY 1, 2
        """,
        params=(meses,),
    )


# ---------------------------------------------------------------------------
# ESTOQUE
# ---------------------------------------------------------------------------


def resumo_do_estoque(usuario: Usuario) -> dict:
    return um(
        usuario,
        """
        SELECT
            sum(quantidade * custo_unitario)                              AS valor_parado,
            count(*)                                                      AS itens,
            count(*) FILTER (WHERE quantidade < estoque_minimo)           AS em_ruptura,
            count(*) FILTER (WHERE validade IS NOT NULL
                               AND validade < current_date)               AS vencidos,
            count(*) FILTER (WHERE validade IS NOT NULL
                               AND validade BETWEEN current_date AND current_date + 30) AS vencendo,
            coalesce(sum(CASE WHEN validade IS NOT NULL AND validade < current_date + 30
                              THEN quantidade * custo_unitario END), 0)   AS valor_em_risco
        FROM base_estoque
        """,
        tabelas=("estoque",),
    )


def itens_em_ruptura(usuario: Usuario, limite: int = 15) -> list[dict]:
    return consultar(
        usuario,
        """
        SELECT unidade, categoria, produto, quantidade, estoque_minimo,
               estoque_minimo - quantidade AS faltando
        FROM base_estoque
        WHERE quantidade < estoque_minimo
        ORDER BY faltando DESC
        LIMIT (?)
        """,
        params=(limite,),
        tabelas=("estoque",),
    )


def itens_vencendo(usuario: Usuario, dias: int = 30, limite: int = 15) -> list[dict]:
    return consultar(
        usuario,
        """
        SELECT unidade, categoria, produto, quantidade, validade,
               date_diff('day', current_date, validade)  AS dias_restantes,
               quantidade * custo_unitario               AS valor
        FROM base_estoque
        WHERE validade IS NOT NULL AND validade <= current_date + (?)
        ORDER BY validade
        LIMIT (?)
        """,
        params=(dias, limite),
        tabelas=("estoque",),
    )


def estoque_encalhado(usuario: Usuario, limite: int = 12) -> list[dict]:
    """Dinheiro parado: muito estoque de item que gira pouco."""
    return consultar(
        usuario,
        """
        WITH giro AS (
            SELECT produto, sum(quantidade) / 90.0 AS venda_dia
            FROM base_venda
            WHERE data >= current_date - 90
            GROUP BY produto
        )
        SELECT e.unidade, e.categoria, e.produto, e.quantidade,
               e.quantidade * e.custo_unitario                       AS valor,
               coalesce(g.venda_dia, 0)                              AS venda_dia,
               CASE WHEN coalesce(g.venda_dia, 0) > 0
                    THEN e.quantidade / g.venda_dia END              AS dias_de_cobertura
        FROM base_estoque e
        LEFT JOIN giro g ON g.produto = e.produto
        WHERE coalesce(g.venda_dia, 0) = 0
           OR e.quantidade / g.venda_dia > 45
        ORDER BY valor DESC
        LIMIT (?)
        """,
        params=(limite,),
        tabelas=("venda", "estoque"),
    )


# ---------------------------------------------------------------------------
# CAIXA
# ---------------------------------------------------------------------------


def fluxo_mensal(usuario: Usuario, meses: int = 18) -> list[dict]:
    return consultar(
        usuario,
        """
        SELECT date_trunc('month', data) AS mes,
               sum(CASE WHEN tipo = 'Entrada' THEN valor ELSE 0 END)       AS entradas,
               -sum(CASE WHEN tipo = 'Saída'  THEN valor ELSE 0 END)       AS saidas,
               sum(valor)                                                  AS saldo
        FROM base_caixa
        WHERE data >= date_trunc('month', current_date) - INTERVAL (?) MONTH
          AND data <  date_trunc('month', current_date)
        GROUP BY 1
        ORDER BY 1
        """,
        params=(meses,),
        tabelas=("caixa",),
    )


def despesas_por_categoria(usuario: Usuario, meses: int = 6) -> list[dict]:
    return consultar(
        usuario,
        """
        SELECT categoria, -sum(valor) AS total
        FROM base_caixa
        WHERE tipo = 'Saída'
          AND data >= date_trunc('month', current_date) - INTERVAL (?) MONTH
        GROUP BY categoria
        ORDER BY total DESC
        """,
        params=(meses,),
        tabelas=("caixa",),
    )


def formas_de_pagamento(usuario: Usuario, dias: int = 90) -> list[dict]:
    return consultar(
        usuario,
        """
        SELECT forma_pagamento, sum(receita) AS receita,
               count(DISTINCT cupom)         AS cupons
        FROM base_venda
        WHERE data >= current_date - (?)
        GROUP BY forma_pagamento
        ORDER BY receita DESC
        """,
        params=(dias,),
    )


def saldo_do_mes(usuario: Usuario) -> dict:
    return um(
        usuario,
        """
        SELECT
            sum(CASE WHEN tipo = 'Entrada' THEN valor ELSE 0 END) AS entradas,
            -sum(CASE WHEN tipo = 'Saída' THEN valor ELSE 0 END)  AS saidas,
            sum(valor)                                            AS saldo
        FROM base_caixa
        WHERE data >= date_trunc('month', current_date)
        """,
        tabelas=("caixa",),
    )


# ---------------------------------------------------------------------------
# FUTURO — projeção explicável
# ---------------------------------------------------------------------------


def previsao(usuario: Usuario, meses_a_frente: int = 3) -> dict:
    """Tendência linear sobre 12 meses × índice de sazonalidade de 24 meses.

    Deliberadamente simples. Para o dono que decide no olho, previsão que não
    se explica em uma frase não é usada — e o método cabe em uma frase:
    *"a média dos últimos meses, corrigida pelo que esse mês costuma ser"*.
    """
    historico = receita_mensal(usuario, meses=24)
    if len(historico) < 6:
        return {"historico": historico, "previsto": [], "metodo": "histórico insuficiente"}

    # `historico` já vem sem o mês corrente. Mas o **primeiro** mês da janela
    # também pode estar pela metade (o dado começa no meio dele), e um mês
    # parcial entrando no cálculo de sazonalidade afunda o índice daquele mês
    # do ano — foi exatamente o que fez a previsão de novembro sair 43% abaixo
    # do real numa verificação. Por isso ele sai fora.
    fechados = historico[1:] if len(historico) > 7 else historico

    valores = [float(linha["receita"]) for linha in fechados]

    # Índice de sazonalidade por mês do ano.
    media_geral = sum(valores) / len(valores)
    por_mes: dict[int, list[float]] = {}
    for linha, valor in zip(fechados, valores):
        por_mes.setdefault(linha["mes"].month, []).append(valor)
    indice = {
        m: (sum(v) / len(v)) / media_geral if media_geral else 1.0
        for m, v in por_mes.items()
    }

    # Tendência: regressão linear simples sobre os 12 últimos meses, já
    # dessazonalizados (senão a tendência vira reflexo do mês de dezembro).
    janela = fechados[-12:]
    y = [
        float(l["receita"]) / indice.get(l["mes"].month, 1.0)
        for l in janela
    ]
    n = len(y)
    x = list(range(n))
    media_x = sum(x) / n
    media_y = sum(y) / n
    denominador = sum((xi - media_x) ** 2 for xi in x) or 1.0
    inclinacao = sum((xi - media_x) * (yi - media_y) for xi, yi in zip(x, y)) / denominador
    intercepto = media_y - inclinacao * media_x

    ultimo_mes = fechados[-1]["mes"]
    previsto = []
    for passo in range(1, meses_a_frente + 1):
        mes = _somar_meses(ultimo_mes.date() if hasattr(ultimo_mes, "date") else ultimo_mes, passo)
        base = intercepto + inclinacao * (n - 1 + passo)
        valor = max(0.0, base * indice.get(mes.month, 1.0))
        previsto.append({"mes": mes, "receita": round(valor, 2)})

    variacao = 0.0
    if valores[-1]:
        variacao = 100.0 * (previsto[0]["receita"] - valores[-1]) / valores[-1]

    return {
        "historico": historico,
        "previsto": previsto,
        "tendencia_mensal": round(inclinacao, 2),
        "variacao_proximo_mes": round(variacao, 1),
        "metodo": "tendência de 12 meses corrigida pela sazonalidade de 24 meses",
    }


def _somar_meses(d: date, meses: int) -> date:
    total = d.month - 1 + meses
    return date(d.year + total // 12, total % 12 + 1, 1)


def previsao_de_caixa(usuario: Usuario) -> dict:
    """Projeta o saldo do mês com base no ritmo de entrada até agora."""
    return um(
        usuario,
        """
        WITH mes AS (
            SELECT
                sum(CASE WHEN tipo = 'Entrada' THEN valor ELSE 0 END) AS entradas,
                -sum(CASE WHEN tipo = 'Saída'  THEN valor ELSE 0 END) AS saidas
            FROM base_caixa
            WHERE data >= date_trunc('month', current_date)
        ),
        anterior AS (
            SELECT -sum(CASE WHEN tipo = 'Saída' THEN valor ELSE 0 END) AS saidas_mes_cheio
            FROM base_caixa
            WHERE data >= date_trunc('month', current_date) - INTERVAL 1 MONTH
              AND data <  date_trunc('month', current_date)
        )
        SELECT
            mes.entradas,
            mes.saidas,
            mes.entradas / nullif(day(current_date), 0) * day(last_day(current_date)) AS entradas_projetadas,
            anterior.saidas_mes_cheio                                                 AS saidas_projetadas,
            mes.entradas / nullif(day(current_date), 0) * day(last_day(current_date))
                - anterior.saidas_mes_cheio                                           AS saldo_projetado
        FROM mes, anterior
        """,
        tabelas=("caixa",),
    )
