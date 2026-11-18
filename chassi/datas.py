"""Nomes de mês em português.

`strftime("%b")` segue a locale do sistema operacional — que em servidor
Linux costuma ser inglês. Num produto brasileiro, "Dec/26" no eixo do
gráfico é defeito, não detalhe. Mapa fixo resolve e não depende de locale
instalada no servidor do cliente.
"""

from datetime import date

CURTOS = ("jan", "fev", "mar", "abr", "mai", "jun",
          "jul", "ago", "set", "out", "nov", "dez")

LONGOS = ("janeiro", "fevereiro", "março", "abril", "maio", "junho",
          "julho", "agosto", "setembro", "outubro", "novembro", "dezembro")


def mes_curto(d: date) -> str:
    """Ex.: 'dez/26' — para eixo de gráfico."""
    return f"{CURTOS[d.month - 1]}/{d.strftime('%y')}"


def mes_longo(d: date) -> str:
    """Ex.: 'dezembro de 2026' — para texto corrido."""
    return f"{LONGOS[d.month - 1]} de {d.year}"
