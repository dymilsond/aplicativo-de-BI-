"""Gera o gabarito dos testes do motor, perguntando ao DuckDB.

O teste do motor compara o resultado dele com o que o banco responde para as
mesmas perguntas, sobre o **dado bruto** — não sobre o cubo. Assim o teste
cobre os dois lados: o cubo foi montado certo e o motor soma certo.

Rodar sempre que o dado mudar:  python -m testes.gerar_gabarito
"""

from __future__ import annotations

import json
from pathlib import Path

import duckdb

from chassi.banco import DIRETORIO_DADOS

NEGOCIOS = ("padaria", "supermercado", "farmacia")
SAIDA = Path(__file__).resolve().parent / "gabarito.json"


def do_negocio(negocio: str) -> dict:
    con = duckdb.connect(str(DIRETORIO_DADOS / f"{negocio}.duckdb"), read_only=True)

    total_receita, total_cupons = con.execute(
        "SELECT sum(receita), count(DISTINCT cupom) FROM venda"
    ).fetchone()

    # O cubo agrega cupons dentro de cada combinação de dimensões, então o
    # total de cupons do motor é a SOMA desses contadores, não a contagem
    # distinta global. É o que o teste precisa comparar.
    cupons_do_cubo = con.execute(
        """
        SELECT sum(c) FROM (
          SELECT count(DISTINCT cupom) AS c FROM venda
          GROUP BY data, unidade, categoria, produto, forma_pagamento)
        """
    ).fetchone()[0]

    por_categoria = dict(
        con.execute(
            "SELECT categoria, sum(receita) FROM venda GROUP BY categoria"
        ).fetchall()
    )

    unidade = con.execute(
        "SELECT unidade FROM venda GROUP BY unidade ORDER BY sum(receita) DESC LIMIT 1"
    ).fetchone()[0]
    receita_unidade = con.execute(
        "SELECT sum(receita) FROM venda WHERE unidade = ?", [unidade]
    ).fetchone()[0]

    primeira = con.execute("SELECT min(data) FROM venda").fetchone()[0]
    de = primeira.replace(day=1)
    ate = con.execute(
        "SELECT max(data) FROM venda WHERE data < ? + INTERVAL 90 DAY", [de]
    ).fetchone()[0]
    receita_periodo = con.execute(
        "SELECT sum(receita) FROM venda WHERE data BETWEEN ? AND ?", [de, ate]
    ).fetchone()[0]

    categoria = con.execute(
        "SELECT categoria FROM venda WHERE unidade = ? GROUP BY categoria "
        "ORDER BY sum(receita) DESC LIMIT 1",
        [unidade],
    ).fetchone()[0]
    receita_cruzada = con.execute(
        "SELECT sum(receita) FROM venda WHERE unidade = ? AND categoria = ?",
        [unidade, categoria],
    ).fetchone()[0]

    con.close()
    return {
        "total_receita": float(total_receita),
        "total_cupons": int(cupons_do_cubo),
        "cupons_distintos_na_base": int(total_cupons),
        "por_categoria": {k: float(v) for k, v in por_categoria.items()},
        "unidade_teste": unidade,
        "receita_da_unidade": float(receita_unidade),
        "periodo": {"de": de.isoformat(), "ate": ate.isoformat(), "receita": float(receita_periodo)},
        "cruzada": {"unidade": unidade, "categoria": categoria, "receita": float(receita_cruzada)},
    }


def main() -> None:
    gabarito = {n: do_negocio(n) for n in NEGOCIOS}
    SAIDA.write_text(json.dumps(gabarito, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"{SAIDA} gerado com {len(gabarito)} negócios.")


if __name__ == "__main__":
    main()
