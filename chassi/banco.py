"""Conexão com o banco de cada negócio.

Uma conexão por negócio, aberta sob demanda e mantida no processo. O objeto
de conexão do DuckDB não é seguro entre threads e endpoint síncrono do
FastAPI roda em threadpool — por isso cada consulta toma um cursor próprio,
que é a unidade segura.

Abre em modo somente leitura: o aplicativo **lê** o dado do cliente, nunca
escreve nele. Se um dia precisar gravar, isso vira decisão explícita, não
acidente.
"""

from __future__ import annotations

import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import duckdb

DIRETORIO_DADOS = Path(__file__).resolve().parent.parent / "dados"

_conexoes: dict[str, duckdb.DuckDBPyConnection] = {}
_trava = threading.Lock()


class BaseIndisponivel(RuntimeError):
    """O banco daquele negócio não existe ainda."""


def caminho(negocio: str) -> Path:
    return DIRETORIO_DADOS / f"{negocio}.duckdb"


def conexao(negocio: str) -> duckdb.DuckDBPyConnection:
    con = _conexoes.get(negocio)
    if con is not None:
        return con

    with _trava:
        con = _conexoes.get(negocio)
        if con is not None:
            return con

        destino = caminho(negocio)
        if not destino.is_file():
            raise BaseIndisponivel(
                f"A base de '{negocio}' não existe em {destino}. "
                "Rode: python -m clientes.gerador"
            )
        con = duckdb.connect(str(destino), read_only=True)
        _conexoes[negocio] = con
        return con


@contextmanager
def cursor(con: duckdb.DuckDBPyConnection) -> Iterator[duckdb.DuckDBPyConnection]:
    cur = con.cursor()
    try:
        yield cur
    finally:
        cur.close()


def fechar_tudo() -> None:
    with _trava:
        for con in _conexoes.values():
            con.close()
        _conexoes.clear()
