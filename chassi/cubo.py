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

import hashlib
import json
import struct
from dataclasses import dataclass
from pathlib import Path

import duckdb

#: Dimensões do cubo de venda, na ordem em que viram colunas.
#:
#: `hora` e `dia_semana` entraram para que **toda** marca da tela seja
#: clicável — regra do produto: o que mostra número, filtra.
#:
#: A hora custa: ela multiplica as linhas por ~4 (supermercado vai de 298 mil
#: para 1,26 milhão, e o arquivo servido de 2,33 MB para 7,67 MB com gzip).
#: Medido, não estimado. Se um dia o peso incomodar — cliente em 4G, por
#: exemplo — tirar "hora" desta tupla reverte tudo: o motor e a tela são
#: genéricos sobre as dimensões e se ajustam sozinhos.
#:
#: `dia_semana` é praticamente de graça: 1 byte por linha, e tão repetitivo
#: que o gzip o reduz a quase nada.
DIMENSOES_VENDA = ("unidade", "categoria", "produto", "forma_pagamento", "hora", "dia_semana")

#: Rótulos legíveis para as dimensões derivadas da data.
DIAS_DA_SEMANA = ("Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado")
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


def montar(caminho_banco: Path, destino: Path, unidades: tuple[str, ...] | None = None) -> dict:
    """Gera `<destino>/cubo.bin` e `<destino>/cubo.json` (o cabeçalho).

    `unidades` é a **redução de dados**, e ela acontece aqui — não na tela.

    Com o motor rodando no navegador, filtrar na interface não é segurança:
    o dado já estaria na máquina do usuário, a um F12 de distância. Então
    cada perfil de acesso recebe um cubo próprio, contendo **apenas** as
    unidades a que tem direito. Quem só enxerga uma loja não recebe os bytes
    das outras — não tem o que vazar.
    """
    destino.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(caminho_banco), read_only=True)

    # `CREATE VIEW` não aceita parâmetro preparado no DuckDB, então o filtro
    # entra direto em cada consulta — sempre como parâmetro, nunca concatenado.
    if unidades:
        filtro = "WHERE unidade IN (" + ", ".join("?" for _ in unidades) + ")"
        p_unid = list(unidades)
    else:
        filtro, p_unid = "", []

    # `hora` vem da tabela; `dia_semana` é derivada aqui, para a tela poder
    # filtrar por "todos os sábados" sem o motor precisar saber o que é data.
    expressoes = {
        "dia_semana": "CASE dayofweek(data) "
        + " ".join(f"WHEN {i} THEN '{n}'" for i, n in enumerate(DIAS_DA_SEMANA))
        + " END",
    }
    dims = ", ".join(expressoes.get(d, d) + f" AS {d}" for d in DIMENSOES_VENDA)
    agrupamento = ", ".join(expressoes.get(d, d) for d in DIMENSOES_VENDA)
    linhas = con.execute(
        f"""
        SELECT data, {dims},
               sum(quantidade)        AS quantidade,
               sum(receita)           AS receita,
               sum(custo)             AS custo,
               count(DISTINCT cupom)  AS cupons
        FROM venda
        {filtro}
        GROUP BY data, {agrupamento}
        ORDER BY data            -- período vira fatia contígua; ver docstring
        """,
        p_unid,
    ).fetchall()

    if not linhas:
        raise ValueError(
            f"Nenhuma venda para as unidades {unidades} em {caminho_banco.name}. "
            "Confira se o nome da unidade no cadastro bate com o do dado."
        )

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


def pasta_do_perfil(negocio: str, unidades: tuple[str, ...] | None) -> str:
    """Nome estável da pasta do cubo de um perfil de acesso.

    Quem vê tudo cai em `<negocio>/todas`; quem tem redução cai numa pasta
    derivada das unidades permitidas, ordenadas para o nome não depender da
    ordem em que vieram.
    """
    if not unidades:
        return f"{negocio}/todas"
    chave = hashlib.sha1("|".join(sorted(unidades)).encode("utf-8")).hexdigest()[:12]
    return f"{negocio}/{chave}"


def montar_todos(diretorio: Path, perfis: dict[str, set[tuple[str, ...] | None]]) -> list[dict]:
    """Gera um cubo por perfil de acesso de cada negócio."""
    saida = []
    for negocio, conjuntos in perfis.items():
        banco = diretorio / f"{negocio}.duckdb"
        for unidades in sorted(conjuntos, key=lambda u: ("" if u is None else "|".join(sorted(u)))):
            pasta = diretorio / "cubo" / pasta_do_perfil(negocio, unidades)
            r = montar(banco, pasta, unidades)
            r["negocio"] = negocio
            r["unidades"] = "todas" if not unidades else ", ".join(unidades)
            r["pasta"] = pasta
            saida.append(r)
    return saida


if __name__ == "__main__":  # pragma: no cover
    from chassi.auth import USUARIOS
    from chassi.banco import DIRETORIO_DADOS

    # Um cubo por perfil que existe no cadastro: ninguém recebe byte de
    # unidade que não pode ver.
    perfis: dict[str, set] = {}
    for cadastro in USUARIOS.values():
        perfis.setdefault(cadastro["negocio"], set()).add(cadastro["unidades"])

    for r in montar_todos(DIRETORIO_DADOS, perfis):
        print(
            f"{r['negocio']:14} {r['unidades'][:34]:34} {r['linhas']:>7,} linhas · "
            f"{r['bytes'] / 1_048_576:5.2f} MB"
        )
