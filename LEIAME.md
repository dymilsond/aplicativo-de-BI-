# Aplicativo de BI — três exemplos completos

Aplicativo web de BI com telas fixas: **você monta, o cliente abre e usa**.
Não é ferramenta de montar painel — é aplicativo.

Três negócios de exemplo, cada um com dois anos de dado fictício realista:
**padaria**, **supermercado** e **farmácia**.

## Rodar

```bash
python -m venv venv
venv\Scripts\activate          # Linux/Mac: source venv/bin/activate
pip install -r requirements.txt
python -m clientes.gerador     # gera as três bases (~30 segundos)
uvicorn chassi.app:app --reload --port 8080
```

Abra **http://localhost:8080** — senha de todos: `123`

| Usuário | Quem é | Enxerga |
|---|---|---|
| `padaria` | Dono da padaria | todas as unidades |
| `padaria.filial` | Gerente da filial | **só a filial** |
| `mercado` | Dona do supermercado | todas as lojas |
| `mercado.olinda` | Gerente de Olinda | **só Olinda** |
| `farmacia` | Dono da farmácia | todas as unidades |
| `farmacia.centro` | Gerente do Centro | **só o Centro** |

Entre com um usuário "todas" e depois com o restrito do mesmo negócio: os
números mudam. Essa é a **redução de dados**, e ela acontece no servidor.

## Telas

| Tela | O que responde |
|---|---|
| **Hoje** | Vendi bem hoje? Em que horário perdi movimento? |
| **Vendas** | Histórico de 2 anos, por categoria, por dia da semana, e **o que vende bem mas lucra mal** |
| **Estoque** | O que está faltando, o que vence, e onde tem dinheiro dormindo |
| **Caixa** | Entrou, saiu, sobrou. Para onde vai o dinheiro |
| **Futuro** | Previsão de faturamento e fechamento de caixa do mês |

## Estrutura

```
chassi/          ← a base reutilizável (escreve uma vez)
  app.py           rotas e renderização
  auth.py          login, sessão, hash de senha
  seguranca.py     REDUÇÃO DE DADOS — ponto único, leia antes de mexer
  banco.py         conexão DuckDB (somente leitura)
  consultas.py     todo o SQL
  datas.py         meses em português
clientes/        ← o que muda por cliente
  catalogo.py      os três negócios: produtos, preços, sazonalidade
  gerador.py       gera o dado fictício
templates/       ← as telas (Jinja2)
app/estatico/    ← CSS, ECharts e HTMX servidos localmente (sem CDN)
dados/           ← os bancos gerados
```

## Segurança — leia isto antes de criar tela nova

Toda consulta passa por `chassi.seguranca.consultar()`, que monta uma CTE
`base_<tabela>` já filtrada pelas unidades do usuário da sessão.

**Sua tela consulta `base_venda`, nunca `venda`.** Um guarda recusa SQL que
referencie a tabela crua — você recebe exceção em vez de dado a mais. Isso
existe porque o risco real não é o conceito, é o esquecimento: uma tela que
consulte direto vaza o dado de todas as lojas e ninguém percebe, porque o
número aparece normalmente, só que maior.

O filtro **nunca** vem do navegador. Sai do usuário autenticado, no servidor.

## Trocar o dado fictício pelo do cliente

1. Em `chassi/banco.py`, aponte para a base real (ou um Parquet gerado pelo ETL).
2. As três tabelas (`venda`, `estoque`, `caixa`) precisam ter a coluna
   `unidade` — é por ela que a redução funciona.
3. Em `clientes/catalogo.py`, troque nome, ramo e cor do negócio.

As telas não mudam.

## Sem CDN

ECharts e HTMX são servidos de `app/estatico/`. O aplicativo funciona em rede
isolada, sem internet — que é a realidade de muito cliente.
