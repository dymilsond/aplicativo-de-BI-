# Imagem do painel.
#
# A versão do Python é FIXA (3.11, não "3" nem "3.x"). O ponto de usar
# container é a caixa ser sempre a mesma; uma tag móvel traria um Python
# diferente daqui a seis meses e desfaria exatamente o que viemos buscar.
FROM python:3.11-slim

# Não gerar .pyc e não bufferizar a saída: sem isso o log do servidor fica
# preso num buffer e você olha o terminal achando que travou.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# As dependências vêm ANTES do código, de propósito.
#
# O Docker guarda cada passo em cache e refaz do ponto que mudou para baixo.
# Código muda toda hora; requirements.txt quase nunca. Nesta ordem, editar
# o painel.js reconstrói em segundos. Na ordem inversa, reinstalaria tudo a
# cada alteração de uma linha.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY chassi/    ./chassi/
COPY app/       ./app/
COPY templates/ ./templates/
COPY clientes/  ./clientes/

# Roda como usuário comum, não como root.
#
# Se alguém achar um furo na aplicação, o que ele ganha é uma conta sem
# poder nenhum dentro de um container — e não a raiz da máquina. Custa uma
# linha e é a diferença entre um susto e um incidente.
RUN useradd --create-home --uid 10001 painel && chown -R painel:painel /app
USER painel

# Os dados NÃO entram na imagem.
#
# São o arquivo do cliente: mudam todo dia, pesam dezenas de MB e não podem
# sumir quando o container é trocado. Entram por volume (ver compose).
VOLUME ["/app/dados"]

EXPOSE 8080

# O Docker pergunta sozinho se a aplicação está viva. Se parar de responder,
# ele marca o container como doente em vez de deixar no ar servindo erro.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/saude', timeout=4).status==200 else 1)"

# Processo único, sem --workers.
#
# Mesmo motivo do Genesis: o DuckDB é single-writer por arquivo e a trava é
# por processo. Um segundo worker abrindo o mesmo banco recebe erro de lock.
# Para escalar, sobe-se mais CONTAINER, não mais worker.
CMD ["uvicorn", "chassi.app:app", "--host", "0.0.0.0", "--port", "8080"]
