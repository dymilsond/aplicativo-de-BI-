"""Exporta o dado do negócio como cubo binário para o motor associativo.

## Por que binário e não JSON

O painel de referência (CADE) manda 3,9 MB de JSON com ~94 mil linhas. Número
em JSON é texto: `12345` ocupa 5 bytes mais a vírgula, e o `JSON.parse` de um
milhão deles custa caro no celular do cliente. Em `Uint16Array` o mesmo valor
ocupa 2 bytes e chega pronto — sem conversão.

Resultado medido nos três negócios: o cubo binário fica em torno de **um terço**
do JSON equivalente, e o navegador não paga parse nenhum.

## Por que o cubo não tem hora

Medido: com `hora` na chave, o supermercado vai a 1,26 milhão de linhas — grande
demais para mandar ao navegador. Sem ela, cai para 299 mil. A análise por hora
do dia ganha um cubo próprio (`data × hora × unidade`), que tem ~35 mil linhas.

## Ordenação por data não é detalhe

As linhas saem **ordenadas por data**. Com isso, filtrar período vira encontrar
dois índices por busca binária e trabalhar na fatia entre eles — sem índice,
sem bitmap, custo zero. É o que evita um bitmap por dia (731 valores), que
sozinho custaria mais memória que o cubo inteiro.
"""

from __future__ import annotations

import json
import struct
from dataclasses import dataclass
from pathlib import Path

import duckdb

#: Dimensões do cubo de venda, na ordem em que viram colunas.
DIMENSOES_VENDA = ("unidade", "categoria", "produto", "forma_pagamento")
#: Medidas somáveis do cubo de venda, com a escala em que viajam.
#:
#: Dinheiro vai em **centavos inteiros**, e quantidade em centésimos. Não é só
#: para comprimir melhor (ganha 13%): somar 300 mil `float` de reais acumula
#: erro de ponto flutuante e o total fecha com centavos de diferença do que o
#: banco diz. Inteiro soma exato. O navegador divide por 100 só na hora de
#: escrever na tela.
MEDIDAS_VENDA = (
    ("quantidade", 100, "I"),
    ("receita", 100, "I"),
    ("custo", 100, "I"),
    ("cupons", 1, "H"),
)


@dataclass
class Coluna:
    nome: str
    #: Valores distintos, na ordem em que o código inteiro os referencia.
    dicionario: list
    #: Largura do inteiro: 1, 2 ou 4 bytes.
    bytes_por_valor: int
    codigos: bytes


def _largura(n_valores: int) -> tuple[int, str]:
    """Menor inteiro que comporta o maior código do dicionário."""
    if n_valores <= 0xFF:
        return 1, "B"
    if n_valores <= 0xFFFF:
        return 2, "H"
    return 4, "I"


def _codificar(valores: list, dicionario: list[str]) -> Coluna:
    indice = {v: i for i, v in enumerate(dicionario)}
    largura, formato = _largura(len(dicionario))
    codigos = struct.pack(f"<{len(valores)}{formato}", *(indice[v] for v in valores))
    return Coluna("", dicionario, largura, codigos)


def _dias_desde(datas: list, origem) -> bytes:
    """Data vira inteiro de 16 bits: dias desde a primeira data do cubo.

    Cabe até 179 anos de histórico, e o navegador reconstrói a data sem
    precisar de parser nenhum.
    """
    return struct.pack(f"<{len(datas)}H", *((d - origem).days for d in datas))


def montar(caminho_banco: Path, destino: Path) -> dict:
    """Gera `<destino>/cubo.bin` e `<destino>/cubo.json` (o cabeçalho)."""
    destino.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(caminho_banco), read_only=True)

    dims = ", ".join(DIMENSOES_VENDA)
    linhas = con.execute(
        f"""
        SELECT data, {dims},
               sum(quantidade)        AS quantidade,
               sum(receita)           AS receita,
               sum(custo)             AS custo,
               count(DISTINCT cupom)  AS cupons
        FROM venda
        GROUP BY data, {dims}
        ORDER BY data            -- período vira fatia contígua; ver docstring
        """
    ).fetchall()

    n = len(linhas)
    datas = [l[0] for l in linhas]
    origem = datas[0]

    blocos: list[bytes] = []
    cabecalho: dict = {
        "linhas": n,
        "origem": origem.isoformat(),
        "dimensoes": [],
        "medidas": [],
        "blocos": [],
    }

    def acrescentar(nome: str, dados: bytes, tipo: str, extra: dict | None = None) -> None:
        cabecalho["blocos"].append(
            {"nome": nome, "tipo": tipo, "inicio": sum(len(b) for b in blocos), "bytes": len(dados)}
        )
        if extra:
            cabecalho["blocos"][-1].update(extra)
        blocos.append(dados)

    acrescentar("data", _dias_desde(datas, origem), "u16")

    for pos, nome in enumerate(DIMENSOES_VENDA, start=1):
        valores = [l[pos] for l in linhas]
        dicionario = sorted(set(valores))
        col = _codificar(valores, dicionario)
        cabecalho["dimensoes"].append({"nome": nome, "valores": dicionario})
        acrescentar(nome, col.codigos, f"u{col.bytes_por_valor * 8}")

    base = 1 + len(DIMENSOES_VENDA)
    for pos, (nome, escala, formato) in enumerate(MEDIDAS_VENDA, start=base):
        valores = [round(float(l[pos]) * escala) for l in linhas]
        limite = 0xFFFF if formato == "H" else 0xFFFFFFFF
        estouro = [v for v in valores if v > limite]
        if estouro:
            raise ValueError(
                f"Medida '{nome}' não cabe em {formato}: maior valor {max(estouro)}. "
                "Aumente a largura em MEDIDAS_VENDA."
            )
        cabecalho["medidas"].append({"nome": nome, "escala": escala})
        largura = 2 if formato == "H" else 4
        acrescentar(nome, struct.pack(f"<{n}{formato}", *valores), f"u{largura * 8}")

    # Cubo da hora: pequeno o bastante para ir inteiro, sem dimensão de produto.
    hora = con.execute(
        """
        SELECT data, hora, unidade, sum(receita) AS receita, count(DISTINCT cupom) AS cupons
        FROM venda GROUP BY data, hora, unidade ORDER BY data
        """
    ).fetchall()
    cabecalho["hora"] = {
        "linhas": len(hora),
        "unidades": sorted({l[2] for l in hora}),
    }
    uni_idx = {u: i for i, u in enumerate(cabecalho["hora"]["unidades"])}
    acrescentar("h_data", _dias_desde([l[0] for l in hora], origem), "u16")
    acrescentar("h_hora", struct.pack(f"<{len(hora)}B", *(l[1] for l in hora)), "u8")
    acrescentar("h_unidade", struct.pack(f"<{len(hora)}B", *(uni_idx[l[2]] for l in hora)), "u8")
    acrescentar(
        "h_receita",
        struct.pack(f"<{len(hora)}I", *(round(float(l[3]) * 100) for l in hora)),
        "u32",
    )
    acrescentar("h_cupons", struct.pack(f"<{len(hora)}I", *(int(l[4]) for l in hora)), "u32")

    con.close()

    binario = b"".join(blocos)
    (destino / "cubo.bin").write_bytes(binario)
    (destino / "cubo.json").write_text(
        json.dumps(cabecalho, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    return {
        "linhas": n,
        "bytes": len(binario),
        "cabecalho_bytes": len((destino / "cubo.json").read_bytes()),
    }


if __name__ == "__main__":  # pragma: no cover
    from chassi.banco import DIRETORIO_DADOS

    for negocio in ("padaria", "supermercado", "farmacia"):
        r = montar(DIRETORIO_DADOS / f"{negocio}.duckdb", DIRETORIO_DADOS / "cubo" / negocio)
        print(
            f"{negocio:14} {r['linhas']:>7,} linhas · "
            f"{r['bytes'] / 1_048_576:5.2f} MB binário + {r['cabecalho_bytes'] / 1024:.1f} KB cabeçalho"
        )
