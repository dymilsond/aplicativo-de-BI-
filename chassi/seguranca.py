"""Redução de dado por usuário — a peça de segurança do aplicativo.

Equivale ao Section Access do Qlik: cada usuário só enxerga as unidades a que
tem direito, e isso é aplicado **no servidor**, antes de o SQL ser montado.

## Por que é feito assim

O risco real não é o conceito, é o esquecimento: uma tela nova que consulte a
tabela direto vaza o dado de todas as lojas. Então aqui existe **um ponto
único de passagem** — `consultar()` — e duas barreiras:

1. A tabela nunca é consultada direto. `consultar()` monta uma CTE
   `base_<tabela>` já filtrada pelas unidades do usuário, e a tela consulta
   essa CTE.
2. Um guarda recusa qualquer SQL que mencione a tabela crua. Se alguém
   escrever `FROM venda` em vez de `FROM base_venda`, a consulta **não roda** —
   levanta exceção em vez de devolver dado a mais.

A segunda barreira existe porque a primeira depende de disciplina humana, e
disciplina humana falha às duas da manhã.

**O filtro nunca vem do navegador.** Nada que o cliente mande influencia a
redução — ela sai do usuário autenticado na sessão.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from chassi import banco

#: Tabelas de negócio. Toda uma delas tem a coluna `unidade`.
TABELAS = ("venda", "estoque", "caixa")

PREFIXO_SEGURO = "base_"


class ConsultaInsegura(RuntimeError):
    """O SQL tentou ler a tabela crua, sem passar pela redução."""


@dataclass(frozen=True)
class Usuario:
    login: str
    nome: str
    #: Qual negócio este usuário enxerga (padaria, supermercado, farmacia).
    negocio: str
    #: Unidades permitidas. `None` significa todas — use com parcimônia.
    unidades: tuple[str, ...] | None
    papel: str = "operador"

    @property
    def ve_tudo(self) -> bool:
        return self.unidades is None

    def descricao_do_acesso(self) -> str:
        if self.ve_tudo:
            return "todas as unidades"
        if len(self.unidades) == 1:
            return self.unidades[0]
        return f"{len(self.unidades)} unidades"


def _cte(usuario: Usuario, tabela: str) -> tuple[str, list]:
    """Monta a CTE já reduzida para uma tabela."""
    if tabela not in TABELAS:
        raise ConsultaInsegura(f"Tabela desconhecida: {tabela!r}")

    if usuario.ve_tudo:
        return f"{PREFIXO_SEGURO}{tabela} AS (SELECT * FROM {tabela})", []

    marcadores = ", ".join("?" for _ in usuario.unidades)
    trecho = (
        f"{PREFIXO_SEGURO}{tabela} AS "
        f"(SELECT * FROM {tabela} WHERE unidade IN ({marcadores}))"
    )
    return trecho, list(usuario.unidades)


def _conferir(sql: str) -> None:
    """Recusa SQL que referencie tabela crua em FROM ou JOIN.

    Sem isso, bastaria uma tela distraída escrevendo `FROM venda` para a
    redução deixar de existir naquela tela — e ninguém perceberia, porque o
    número apareceria normalmente, só que maior.
    """
    for tabela in TABELAS:
        padrao = rf"\b(from|join)\s+{tabela}\b"
        if re.search(padrao, sql, flags=re.IGNORECASE):
            raise ConsultaInsegura(
                f"A consulta referencia a tabela '{tabela}' diretamente. "
                f"Use '{PREFIXO_SEGURO}{tabela}', que já vem reduzida para o "
                "usuário da sessão."
            )


def consultar(usuario: Usuario, sql: str, params=(), tabelas=("venda",)) -> list[dict]:
    """Única forma de ler dado de negócio. Devolve lista de dicionários.

    `sql` consulta `base_venda` / `base_estoque` / `base_caixa`, nunca a
    tabela crua. Os parâmetros da redução entram antes dos seus — por isso a
    CTE vem primeiro na instrução, e é por isso que a ordem nunca quebra.
    """
    _conferir(sql)

    trechos, params_reducao = [], []
    for tabela in tabelas:
        trecho, p = _cte(usuario, tabela)
        trechos.append(trecho)
        params_reducao.extend(p)

    # A consulta da tela pode ter CTEs próprias. Nesse caso as duas listas se
    # juntam numa só — `WITH a AS (...), b AS (...)` — porque SQL não aceita
    # dois `WITH` na mesma instrução.
    corpo = sql.lstrip()
    if corpo[:5].upper() == "WITH ":
        corpo = corpo[5:]
        separador = ",\n     "
    else:
        separador = "\n"

    sql_final = "WITH " + ",\n     ".join(trechos) + separador + corpo
    con = banco.conexao(usuario.negocio)

    with banco.cursor(con) as cur:
        resultado = cur.execute(sql_final, [*params_reducao, *params])
        nomes = [c[0] for c in resultado.description]
        return [dict(zip(nomes, linha)) for linha in resultado.fetchall()]


def um(usuario: Usuario, sql: str, params=(), tabelas=("venda",)) -> dict:
    """Mesma coisa, para consulta que devolve uma linha só."""
    linhas = consultar(usuario, sql, params, tabelas)
    return linhas[0] if linhas else {}
