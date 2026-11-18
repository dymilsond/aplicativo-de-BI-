"""Autenticação e cadastro de usuários.

Senha nunca é armazenada em texto — só o hash bcrypt. O login confere o hash
e, dando certo, grava na sessão apenas o **login**; o resto (negócio e
unidades permitidas) é relido do cadastro a cada requisição.

Isso é deliberado: se a permissão de alguém mudar, a mudança vale na próxima
requisição, não no próximo login. E nada que o navegador guarde influencia o
que o usuário pode ver.

Sessão em cookie assinado e `httponly` — não em `localStorage`. JavaScript da
página não alcança o cookie, então XSS não rouba a sessão.
"""

from __future__ import annotations

import os
import secrets

import bcrypt
from itsdangerous import BadSignature, URLSafeSerializer

from chassi.seguranca import Usuario

#: Hash de "123" — **somente para a demonstração**. Em uso real, cada usuário
#: tem o seu, gerado por `python -m chassi.auth hash <senha>`.
_DEMO = "$2b$10$R7rAp4gI2SH84jOCttps2.iLHPF4GgoIs5cOHcojOi2DzstpojWfW"


#: Cadastro de usuários. Em produção isto vira tabela; aqui fica em código
#: para o exemplo subir sem banco de usuário.
#:
#: `unidades=None` significa "vê todas". Qualquer outra coisa é redução.
USUARIOS: dict[str, dict] = {
    # ---- Padaria ----
    "padaria": {
        "senha": _DEMO, "nome": "Seu Antônio (dono)", "negocio": "padaria",
        "unidades": None, "papel": "gestor",
    },
    "padaria.filial": {
        "senha": _DEMO, "nome": "Márcia (gerente da filial)", "negocio": "padaria",
        "unidades": ("Filial - Boa Viagem",), "papel": "operador",
    },
    # ---- Supermercado ----
    "mercado": {
        "senha": _DEMO, "nome": "Dona Célia (proprietária)", "negocio": "supermercado",
        "unidades": None, "papel": "gestor",
    },
    "mercado.olinda": {
        "senha": _DEMO, "nome": "Rogério (gerente Olinda)", "negocio": "supermercado",
        "unidades": ("Loja 03 - Olinda",), "papel": "operador",
    },
    # ---- Farmácia ----
    "farmacia": {
        "senha": _DEMO, "nome": "Dr. Paulo (proprietário)", "negocio": "farmacia",
        "unidades": None, "papel": "gestor",
    },
    "farmacia.centro": {
        "senha": _DEMO, "nome": "Juliana (gerente Centro)", "negocio": "farmacia",
        "unidades": ("Unidade Centro",), "papel": "operador",
    },
}

NOME_DO_COOKIE = "sessao"

#: Em produção isto vem de variável de ambiente e **não muda entre reinícios**
#: (senão todo mundo é deslogado a cada deploy).
_CHAVE = os.environ.get("CHAVE_DA_SESSAO") or secrets.token_urlsafe(32)
_serializador = URLSafeSerializer(_CHAVE, salt="sessao-bi")


def gerar_hash(senha: str) -> str:
    return bcrypt.hashpw(senha.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def conferir_senha(senha: str, hash_guardado: str) -> bool:
    try:
        return bcrypt.checkpw(senha.encode("utf-8"), hash_guardado.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def autenticar(login: str, senha: str) -> Usuario | None:
    """Devolve o usuário ou `None`. Nunca diz *qual* dos dois estava errado."""
    cadastro = USUARIOS.get((login or "").strip().lower())
    if cadastro is None:
        # Gasta o mesmo tempo de um hash real, para o tempo de resposta não
        # entregar quais logins existem.
        bcrypt.checkpw(b"x", _DEMO.encode())
        return None
    if not conferir_senha(senha, cadastro["senha"]):
        return None
    return montar(login.strip().lower())


def montar(login: str) -> Usuario | None:
    cadastro = USUARIOS.get(login)
    if cadastro is None:
        return None
    return Usuario(
        login=login,
        nome=cadastro["nome"],
        negocio=cadastro["negocio"],
        unidades=cadastro["unidades"],
        papel=cadastro["papel"],
    )


def assinar(login: str) -> str:
    return _serializador.dumps({"login": login})


def ler_cookie(valor: str | None) -> Usuario | None:
    if not valor:
        return None
    try:
        dados = _serializador.loads(valor)
    except BadSignature:
        return None
    return montar(dados.get("login", ""))


if __name__ == "__main__":  # pragma: no cover
    import sys

    if len(sys.argv) == 3 and sys.argv[1] == "hash":
        print(gerar_hash(sys.argv[2]))
    else:
        print("uso: python -m chassi.auth hash <senha>")
