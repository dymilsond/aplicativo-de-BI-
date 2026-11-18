"""Aplicação web — rotas, sessão e renderização das telas.

Cada tela é uma rota que devolve HTML pronto do servidor (Jinja2). Sem SPA:
HTMX cuida da interatividade e o ECharts desenha. Para um aplicativo de telas
fixas, essa combinação é a mais rápida de escrever e a mais fácil de manter.

**Toda rota de tela passa por `usuario_logado`**, que lê o cookie assinado e
monta o usuário. Sem usuário, redireciona para o login. É o segundo ponto
único do sistema — o primeiro é a redução de dado em `seguranca.consultar`.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import Depends, FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from chassi import auth, banco, consultas, cubo
from chassi.datas import mes_curto, mes_longo
from chassi.seguranca import ConsultaInsegura, Usuario
from clientes.catalogo import NEGOCIOS

RAIZ = Path(__file__).resolve().parent.parent
templates = Jinja2Templates(directory=str(RAIZ / "templates"))
# Disponível em qualquer template, sem precisar passar no contexto.
templates.env.globals["mes_longo"] = mes_longo


def _versao_estatico() -> str:
    """Carimbo que muda quando qualquer arquivo de `estatico/` muda.

    Sem isso, o navegador segura o CSS antigo depois de um `git pull` e a
    tela aparece com o HTML novo e o estilo velho — que é indistinguível de
    "não atualizou". Aconteceu de verdade: o log mostrava
    `GET /estatico/estilo.css 304 Not Modified` e a pessoa via a tela crua.

    Mesmo padrão do painel de Gestão de Pessoas do Cade
    (`style.css?v=20261105-1700`), só que calculado em vez de escrito à mão —
    carimbo escrito à mão é carimbo que alguém esquece de trocar.
    """
    pasta = RAIZ / "app" / "estatico"
    try:
        recente = max(f.stat().st_mtime for f in pasta.iterdir() if f.is_file())
    except (OSError, ValueError):
        return "0"
    return str(int(recente))


templates.env.globals["v"] = _versao_estatico()

app = FastAPI(title="BI para o seu negócio", docs_url=None, redoc_url=None)
class EstaticoSemCacheTeimoso(StaticFiles):
    """Serve `estatico/` pedindo revalidação a cada carga.

    O `?v=` resolve o CSS e o `painel.js`, mas `motor.js` entra por `import`
    de dentro do `painel.js` e não passa pelo template — não tem como
    carimbar. `no-cache` obriga o navegador a perguntar ao servidor se mudou
    (resposta 304 continua barata) em vez de usar a cópia dele às cegas.
    """

    def file_response(self, *args, **kwargs):
        resposta = super().file_response(*args, **kwargs)
        resposta.headers["Cache-Control"] = "no-cache"
        return resposta


app.mount("/estatico", EstaticoSemCacheTeimoso(directory=str(RAIZ / "app" / "estatico")), name="estatico")


# ---------------------------------------------------------------------------
# Sessão
# ---------------------------------------------------------------------------


def usuario_logado(request: Request) -> Usuario:
    usuario = auth.ler_cookie(request.cookies.get(auth.NOME_DO_COOKIE))
    if usuario is None:
        raise HTTPException(status_code=307, headers={"Location": "/entrar"})
    return usuario


def _contexto(request: Request, usuario: Usuario, tela: str, **extra) -> dict:
    negocio = NEGOCIOS[usuario.negocio]
    return {
        "usuario": usuario,
        "negocio": negocio,
        "tela": tela,
        **extra,
    }


@app.exception_handler(HTTPException)
async def _redirecionar(request: Request, exc: HTTPException):
    if exc.status_code == 307 and "Location" in (exc.headers or {}):
        return RedirectResponse(exc.headers["Location"], status_code=307)
    return JSONResponse({"erro": exc.detail}, status_code=exc.status_code)


@app.exception_handler(ConsultaInsegura)
async def _consulta_insegura(request: Request, exc: ConsultaInsegura):
    # Falha alto de propósito: é erro de programação, não do usuário.
    return JSONResponse({"erro": f"Consulta recusada pela segurança: {exc}"}, status_code=500)


@app.exception_handler(banco.BaseIndisponivel)
async def _sem_base(request: Request, exc: banco.BaseIndisponivel):
    return HTMLResponse(
        f"<h1>Base não encontrada</h1><p>{exc}</p>", status_code=503
    )


# ---------------------------------------------------------------------------
# Entrar / sair
# ---------------------------------------------------------------------------


@app.get("/entrar", response_class=HTMLResponse)
def tela_de_login(request: Request, erro: str | None = None):
    return templates.TemplateResponse(
        request=request, name="login.html",
        context={"erro": erro, "negocios": NEGOCIOS},
    )


@app.post("/entrar")
def entrar(login: str = Form(...), senha: str = Form(...)):
    usuario = auth.autenticar(login, senha)
    if usuario is None:
        return RedirectResponse("/entrar?erro=1", status_code=303)

    resposta = RedirectResponse("/", status_code=303)
    resposta.set_cookie(
        auth.NOME_DO_COOKIE,
        auth.assinar(usuario.login),
        httponly=True,     # JavaScript da página não alcança o cookie
        samesite="lax",    # não viaja em requisição de outro site
        max_age=8 * 3600,
    )
    return resposta


@app.get("/sair")
def sair():
    resposta = RedirectResponse("/entrar", status_code=303)
    resposta.delete_cookie(auth.NOME_DO_COOKIE)
    return resposta


# ---------------------------------------------------------------------------
# Telas
# ---------------------------------------------------------------------------


@app.get("/", response_class=HTMLResponse)
def hoje(request: Request, usuario: Usuario = Depends(usuario_logado)):
    kpis = consultas.kpis_de_hoje(usuario)
    mes = consultas.kpis_do_mes(usuario)
    hora = consultas.movimento_por_hora(usuario)
    unidades = consultas.receita_por_unidade_hoje(usuario)

    grafico_hora = {
        "horas": [int(l["hora"]) for l in hora],
        "hoje": [float(l["hoje"]) for l in hora],
        "media": [round(float(l["media"]), 2) for l in hora],
    }
    return templates.TemplateResponse(
        request=request, name="hoje.html",
        context=_contexto(
            request, usuario, "hoje",
            kpis=kpis, mes=mes, unidades=unidades,
            grafico_hora=json.dumps(grafico_hora),
        ),
    )


@app.get("/vendas", response_class=HTMLResponse)
def vendas(request: Request, usuario: Usuario = Depends(usuario_logado), dias: int = 90):
    if dias not in (30, 90, 180, 365):
        dias = 90

    mensal = consultas.receita_mensal(usuario)
    categorias = consultas.receita_por_categoria(usuario, dias)
    semana = consultas.receita_por_dia_da_semana(usuario)
    produtos = consultas.top_produtos(usuario, dias)
    viloes = consultas.vilaes_de_margem(usuario, dias)
    unidades = consultas.comparativo_de_unidades(usuario)

    graficos = {
        "mensal": {
            "meses": [mes_curto(l["mes"]) for l in mensal],
            "receita": [float(l["receita"]) for l in mensal],
            "margem": [float(l["margem"]) for l in mensal],
        },
        "categorias": [
            {"name": l["categoria"], "value": round(float(l["receita"]), 2)}
            for l in categorias
        ],
        "semana": {
            "dias": [l["dia"] for l in semana],
            "valores": [round(float(l["receita_media"]), 2) for l in semana],
        },
        "unidades": _serie_por_unidade(unidades),
    }
    return templates.TemplateResponse(
        request=request, name="vendas.html",
        context=_contexto(
            request, usuario, "vendas",
            dias=dias, categorias=categorias, produtos=produtos, viloes=viloes,
            graficos=json.dumps(graficos),
        ),
    )


@app.get("/estoque", response_class=HTMLResponse)
def estoque(request: Request, usuario: Usuario = Depends(usuario_logado)):
    resumo = consultas.resumo_do_estoque(usuario)
    ruptura = consultas.itens_em_ruptura(usuario)
    vencendo = consultas.itens_vencendo(usuario)
    encalhado = consultas.estoque_encalhado(usuario)
    return templates.TemplateResponse(
        request=request, name="estoque.html",
        context=_contexto(
            request, usuario, "estoque",
            resumo=resumo, ruptura=ruptura, vencendo=vencendo, encalhado=encalhado,
        ),
    )


@app.get("/caixa", response_class=HTMLResponse)
def caixa(request: Request, usuario: Usuario = Depends(usuario_logado)):
    fluxo = consultas.fluxo_mensal(usuario)
    despesas = consultas.despesas_por_categoria(usuario)
    formas = consultas.formas_de_pagamento(usuario)
    mes = consultas.saldo_do_mes(usuario)

    graficos = {
        "fluxo": {
            "meses": [mes_curto(l["mes"]) for l in fluxo],
            "entradas": [float(l["entradas"]) for l in fluxo],
            "saidas": [float(l["saidas"]) for l in fluxo],
            "saldo": [float(l["saldo"]) for l in fluxo],
        },
        "despesas": [
            {"name": l["categoria"], "value": round(float(l["total"]), 2)}
            for l in despesas
        ],
        "formas": [
            {"name": l["forma_pagamento"], "value": round(float(l["receita"]), 2)}
            for l in formas
        ],
    }
    return templates.TemplateResponse(
        request=request, name="caixa.html",
        context=_contexto(
            request, usuario, "caixa",
            mes=mes, despesas=despesas, formas=formas,
            graficos=json.dumps(graficos),
        ),
    )


@app.get("/futuro", response_class=HTMLResponse)
def futuro(request: Request, usuario: Usuario = Depends(usuario_logado)):
    prev = consultas.previsao(usuario)
    caixa_prev = consultas.previsao_de_caixa(usuario)

    historico = prev["historico"]
    previsto = prev["previsto"]
    meses = [mes_curto(l["mes"]) for l in historico] + [
        mes_curto(l["mes"]) for l in previsto
    ]
    serie_real = [float(l["receita"]) for l in historico] + [None] * len(previsto)
    # O primeiro ponto previsto repete o último real para a linha não quebrar.
    serie_prev = [None] * (len(historico) - 1) + [
        float(historico[-1]["receita"])
    ] + [l["receita"] for l in previsto]

    grafico = {"meses": meses, "real": serie_real, "previsto": serie_prev}
    return templates.TemplateResponse(
        request=request, name="futuro.html",
        context=_contexto(
            request, usuario, "futuro",
            prev=prev, caixa=caixa_prev, grafico=json.dumps(grafico),
        ),
    )


# ---------------------------------------------------------------------------


def _serie_por_unidade(linhas: list[dict]) -> dict:
    meses = sorted({l["mes"] for l in linhas})
    unidades = sorted({l["unidade"] for l in linhas})
    mapa = {(l["mes"], l["unidade"]): float(l["receita"]) for l in linhas}
    return {
        "meses": [mes_curto(m) for m in meses],
        "series": [
            {"nome": u, "valores": [mapa.get((m, u), 0) for m in meses]}
            for u in unidades
        ],
    }


# ---------------------------------------------------------------------------
# Cubo do motor associativo
# ---------------------------------------------------------------------------


@app.get("/cubo/{arquivo}")
def servir_cubo(arquivo: str, usuario: Usuario = Depends(usuario_logado)):
    """Entrega o cubo **do perfil do usuário da sessão**.

    O caminho nunca vem do cliente: ele é derivado do usuário autenticado.
    Um usuário com redução recebe um arquivo que só contém as unidades dele —
    a redução é no byte, não na tela. Com o motor rodando no navegador,
    filtrar na interface não seria segurança nenhuma.
    """
    if arquivo not in ("cubo.json", "cubo.bin"):
        raise HTTPException(status_code=404, detail="Arquivo de cubo desconhecido.")

    pasta = banco.DIRETORIO_DADOS / "cubo" / cubo.pasta_do_perfil(
        usuario.negocio, usuario.unidades
    )
    destino = pasta / arquivo
    if not destino.is_file():
        raise HTTPException(
            status_code=503,
            detail="O cubo deste perfil ainda não foi gerado. Rode: python -m chassi.cubo",
        )
    tipo = "application/json" if arquivo.endswith(".json") else "application/octet-stream"
    return FileResponse(destino, media_type=tipo, headers={"Cache-Control": "no-store"})


@app.get("/painel", response_class=HTMLResponse)
def painel(request: Request, usuario: Usuario = Depends(usuario_logado)):
    """Painel associativo: tudo clica, tudo responde."""
    return templates.TemplateResponse(
        request=request, name="painel.html",
        context=_contexto(request, usuario, "painel"),
    )


@app.get("/saude")
def saude():
    return {"status": "ok"}
