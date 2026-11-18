"""Catálogo dos três negócios de exemplo.

Cada negócio descreve: unidades (lojas), categorias, produtos com preço e
custo, curva de movimento ao longo do dia, e sazonalidade do ano. É daqui
que o gerador tira tudo — trocar de ramo é trocar este arquivo.
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Produto:
    nome: str
    categoria: str
    preco: float
    custo: float
    #: Peso relativo de venda. 1.0 = produto mediano da loja.
    giro: float = 1.0
    #: Validade típica em dias (None = não perecível).
    validade_dias: int | None = None
    #: Produto controlado / com receita (farmácia).
    controlado: bool = False


@dataclass(frozen=True)
class Negocio:
    chave: str
    nome: str
    ramo: str
    unidades: tuple[str, ...]
    #: Peso de cada unidade (loja maior vende mais).
    porte: dict[str, float]
    #: Horário de funcionamento (hora inicial, hora final).
    expediente: tuple[int, int]
    #: Peso por hora do dia — o pico de cada ramo é diferente.
    curva_hora: dict[int, float]
    #: Peso por dia da semana (0 = segunda).
    curva_semana: dict[int, float]
    #: Peso por mês (1 a 12).
    curva_mes: dict[int, float]
    produtos: tuple[Produto, ...]
    formas_pagamento: tuple[tuple[str, float], ...]
    #: Despesas fixas mensais (nome, valor aproximado).
    despesas: tuple[tuple[str, float], ...]
    #: Ticket médio esperado — calibra quantos itens por cupom.
    itens_por_cupom: tuple[int, int] = (1, 4)
    cor: str = "#2563eb"
    telas_extras: tuple[str, ...] = field(default=())


# ---------------------------------------------------------------------------
# PADARIA — pico no café da manhã e no fim de tarde, muita perda de perecível
# ---------------------------------------------------------------------------

PADARIA = Negocio(
    chave="padaria",
    nome="Padaria Pão Nosso",
    ramo="Padaria e Confeitaria",
    unidades=("Matriz - Centro", "Filial - Boa Viagem"),
    porte={"Matriz - Centro": 1.0, "Filial - Boa Viagem": 0.65},
    expediente=(6, 20),
    curva_hora={
        6: 1.6, 7: 2.4, 8: 2.0, 9: 1.2, 10: 0.8, 11: 0.9, 12: 1.1, 13: 0.8,
        14: 0.6, 15: 0.7, 16: 1.0, 17: 1.8, 18: 2.2, 19: 1.4, 20: 0.6,
    },
    curva_semana={0: 0.95, 1: 0.95, 2: 1.0, 3: 1.05, 4: 1.2, 5: 1.4, 6: 1.3},
    curva_mes={
        1: 0.9, 2: 0.9, 3: 1.0, 4: 1.1, 5: 1.0, 6: 1.05,
        7: 1.0, 8: 0.95, 9: 1.0, 10: 1.05, 11: 1.05, 12: 1.45,
    },
    produtos=(
        Produto("Pão Francês (kg)", "Panificação", 18.90, 7.20, giro=5.0, validade_dias=1),
        Produto("Pão de Forma", "Panificação", 12.50, 6.80, giro=1.2, validade_dias=5),
        Produto("Baguete", "Panificação", 9.90, 3.60, giro=1.0, validade_dias=1),
        Produto("Pão de Queijo (100g)", "Panificação", 7.50, 3.10, giro=2.2, validade_dias=2),
        Produto("Croissant", "Panificação", 8.90, 3.40, giro=0.8, validade_dias=2),
        Produto("Bolo de Chocolate (fatia)", "Confeitaria", 9.50, 3.20, giro=1.4, validade_dias=3),
        Produto("Torta de Limão (fatia)", "Confeitaria", 12.00, 4.50, giro=0.7, validade_dias=3),
        Produto("Sonho", "Confeitaria", 6.50, 2.30, giro=1.1, validade_dias=1),
        Produto("Coxinha", "Salgados", 8.00, 2.90, giro=2.6, validade_dias=1),
        Produto("Empada de Frango", "Salgados", 8.50, 3.10, giro=1.3, validade_dias=1),
        Produto("Pastel Assado", "Salgados", 7.50, 2.70, giro=1.5, validade_dias=1),
        Produto("Café Expresso", "Cafeteria", 5.50, 1.20, giro=3.0),
        Produto("Cappuccino", "Cafeteria", 9.00, 2.40, giro=1.4),
        Produto("Suco Natural 300ml", "Cafeteria", 10.00, 3.50, giro=0.9, validade_dias=2),
        Produto("Leite 1L", "Mercearia", 6.90, 5.10, giro=1.0, validade_dias=20),
        Produto("Refrigerante Lata", "Mercearia", 6.00, 3.40, giro=1.2, validade_dias=180),
    ),
    formas_pagamento=(("Pix", 0.34), ("Débito", 0.27), ("Dinheiro", 0.22), ("Crédito", 0.17)),
    despesas=(
        ("Folha de pagamento", 28000), ("Aluguel", 7500), ("Energia elétrica", 4200),
        ("Fornecedores - farinha e insumos", 19000), ("Gás", 2100),
        ("Impostos (Simples)", 9800), ("Água", 900), ("Manutenção", 1200),
    ),
    itens_por_cupom=(1, 4),
    cor="#b45309",
    telas_extras=("perdas",),
)


# ---------------------------------------------------------------------------
# SUPERMERCADO — pico no sábado e no começo do mês, volume alto, margem baixa
# ---------------------------------------------------------------------------

SUPERMERCADO = Negocio(
    chave="supermercado",
    nome="Supermercado Bom Preço",
    ramo="Supermercado de Vizinhança",
    unidades=("Loja 01 - Centro", "Loja 02 - Imbiribeira", "Loja 03 - Olinda"),
    porte={"Loja 01 - Centro": 1.0, "Loja 02 - Imbiribeira": 0.8, "Loja 03 - Olinda": 0.55},
    expediente=(7, 22),
    curva_hora={
        7: 0.5, 8: 0.9, 9: 1.2, 10: 1.4, 11: 1.5, 12: 1.2, 13: 0.9, 14: 1.0,
        15: 1.1, 16: 1.3, 17: 1.8, 18: 2.2, 19: 2.0, 20: 1.4, 21: 0.8, 22: 0.3,
    },
    curva_semana={0: 0.85, 1: 0.85, 2: 0.9, 3: 1.0, 4: 1.25, 5: 1.6, 6: 0.9},
    curva_mes={
        1: 1.0, 2: 0.9, 3: 0.95, 4: 1.0, 5: 1.05, 6: 1.0,
        7: 1.0, 8: 0.95, 9: 0.95, 10: 1.0, 11: 1.05, 12: 1.35,
    },
    produtos=(
        Produto("Arroz 5kg", "Mercearia", 27.90, 22.40, giro=3.0, validade_dias=365),
        Produto("Feijão 1kg", "Mercearia", 8.90, 6.70, giro=2.8, validade_dias=300),
        Produto("Açúcar 1kg", "Mercearia", 5.49, 4.30, giro=2.2, validade_dias=365),
        Produto("Óleo de Soja 900ml", "Mercearia", 7.90, 6.20, giro=2.0, validade_dias=365),
        Produto("Macarrão 500g", "Mercearia", 4.90, 3.40, giro=1.8, validade_dias=300),
        Produto("Café 500g", "Mercearia", 21.90, 17.50, giro=1.9, validade_dias=270),
        Produto("Banana (kg)", "Hortifruti", 6.90, 4.10, giro=2.6, validade_dias=4),
        Produto("Tomate (kg)", "Hortifruti", 9.90, 6.30, giro=2.1, validade_dias=5),
        Produto("Batata (kg)", "Hortifruti", 7.50, 4.60, giro=2.0, validade_dias=10),
        Produto("Alface (un)", "Hortifruti", 4.50, 2.60, giro=1.3, validade_dias=3),
        Produto("Cebola (kg)", "Hortifruti", 6.90, 4.20, giro=1.6, validade_dias=20),
        Produto("Picanha (kg)", "Açougue", 89.90, 71.00, giro=0.7, validade_dias=5),
        Produto("Coxão Mole (kg)", "Açougue", 42.90, 34.50, giro=1.5, validade_dias=5),
        Produto("Frango Inteiro (kg)", "Açougue", 14.90, 11.30, giro=2.4, validade_dias=4),
        Produto("Linguiça Toscana (kg)", "Açougue", 26.90, 20.10, giro=1.2, validade_dias=7),
        Produto("Leite 1L", "Frios e Laticínios", 6.49, 5.20, giro=3.2, validade_dias=25),
        Produto("Queijo Mussarela (kg)", "Frios e Laticínios", 44.90, 35.80, giro=1.4, validade_dias=30),
        Produto("Presunto (kg)", "Frios e Laticínios", 32.90, 25.40, giro=1.1, validade_dias=21),
        Produto("Iogurte 170g", "Frios e Laticínios", 3.49, 2.40, giro=1.9, validade_dias=30),
        Produto("Manteiga 200g", "Frios e Laticínios", 12.90, 9.80, giro=1.2, validade_dias=90),
        Produto("Refrigerante 2L", "Bebidas", 9.90, 7.10, giro=2.7, validade_dias=180),
        Produto("Cerveja Lata", "Bebidas", 4.49, 3.20, giro=3.4, validade_dias=270),
        Produto("Água Mineral 1,5L", "Bebidas", 3.49, 2.10, giro=2.0, validade_dias=365),
        Produto("Suco de Caixa 1L", "Bebidas", 7.90, 5.60, giro=1.3, validade_dias=180),
        Produto("Detergente", "Limpeza", 2.99, 1.90, giro=2.1, validade_dias=730),
        Produto("Sabão em Pó 1kg", "Limpeza", 15.90, 12.10, giro=1.6, validade_dias=730),
        Produto("Desinfetante 2L", "Limpeza", 9.90, 6.80, giro=1.2, validade_dias=730),
        Produto("Papel Higiênico 12un", "Higiene", 24.90, 18.60, giro=1.8, validade_dias=1095),
        Produto("Sabonete", "Higiene", 2.79, 1.60, giro=1.7, validade_dias=1095),
        Produto("Creme Dental", "Higiene", 7.90, 5.30, giro=1.4, validade_dias=1095),
        Produto("Shampoo 350ml", "Higiene", 18.90, 13.20, giro=0.9, validade_dias=1095),
        Produto("Pão Francês (kg)", "Padaria", 18.90, 8.10, giro=3.6, validade_dias=1),
        Produto("Bolo Caseiro", "Padaria", 16.90, 8.40, giro=0.8, validade_dias=4),
        Produto("Pizza Congelada", "Congelados", 19.90, 14.60, giro=1.1, validade_dias=180),
        Produto("Hambúrguer Congelado", "Congelados", 23.90, 17.90, giro=1.0, validade_dias=180),
        Produto("Batata Frita Congelada", "Congelados", 18.90, 13.70, giro=0.9, validade_dias=365),
    ),
    formas_pagamento=(("Débito", 0.31), ("Crédito", 0.28), ("Pix", 0.26), ("Dinheiro", 0.15)),
    despesas=(
        ("Folha de pagamento", 96000), ("Aluguel", 32000), ("Energia elétrica", 24000),
        ("Fornecedores", 340000), ("Impostos", 41000), ("Frete e logística", 12000),
        ("Água", 3200), ("Manutenção e limpeza", 6800), ("Segurança", 7400),
    ),
    itens_por_cupom=(3, 14),
    cor="#15803d",
    telas_extras=("ruptura",),
)


# ---------------------------------------------------------------------------
# FARMÁCIA — sazonalidade de inverno, validade crítica, convênio e controlados
# ---------------------------------------------------------------------------

FARMACIA = Negocio(
    chave="farmacia",
    nome="Drogaria Saúde Total",
    ramo="Farmácia e Drogaria",
    unidades=("Unidade Centro", "Unidade Casa Forte"),
    porte={"Unidade Centro": 1.0, "Unidade Casa Forte": 0.72},
    expediente=(7, 22),
    curva_hora={
        7: 0.7, 8: 1.2, 9: 1.4, 10: 1.3, 11: 1.2, 12: 1.0, 13: 0.9, 14: 1.0,
        15: 1.1, 16: 1.2, 17: 1.5, 18: 1.8, 19: 1.6, 20: 1.1, 21: 0.7, 22: 0.4,
    },
    curva_semana={0: 1.1, 1: 1.05, 2: 1.0, 3: 1.0, 4: 1.1, 5: 1.0, 6: 0.7},
    curva_mes={
        1: 0.95, 2: 0.9, 3: 1.0, 4: 1.1, 5: 1.25, 6: 1.35,
        7: 1.4, 8: 1.3, 9: 1.1, 10: 0.95, 11: 0.9, 12: 0.95,
    },
    produtos=(
        Produto("Dipirona 500mg", "Medicamento Genérico", 8.90, 4.20, giro=3.4, validade_dias=540),
        Produto("Paracetamol 750mg", "Medicamento Genérico", 11.90, 5.60, giro=2.8, validade_dias=540),
        Produto("Ibuprofeno 600mg", "Medicamento Genérico", 16.90, 8.10, giro=1.9, validade_dias=540),
        Produto("Omeprazol 20mg", "Medicamento Genérico", 14.90, 6.80, giro=2.3, validade_dias=540),
        Produto("Losartana 50mg", "Medicamento Genérico", 12.90, 5.90, giro=2.6, validade_dias=720),
        Produto("Metformina 850mg", "Medicamento Genérico", 15.90, 7.40, giro=1.8, validade_dias=720),
        Produto("Amoxicilina 500mg", "Medicamento Genérico", 28.90, 14.60, giro=1.2, validade_dias=360, controlado=True),
        Produto("Dorflex", "Medicamento Referência", 22.90, 15.80, giro=2.1, validade_dias=540),
        Produto("Neosaldina", "Medicamento Referência", 26.90, 18.40, giro=1.6, validade_dias=540),
        Produto("Buscopan", "Medicamento Referência", 31.90, 22.10, giro=1.3, validade_dias=540),
        Produto("Rivotril 2mg", "Controlado", 42.90, 29.80, giro=0.8, validade_dias=540, controlado=True),
        Produto("Fluoxetina 20mg", "Controlado", 34.90, 21.60, giro=0.9, validade_dias=540, controlado=True),
        Produto("Clonazepam 2mg", "Controlado", 38.90, 25.40, giro=0.7, validade_dias=540, controlado=True),
        Produto("Antigripal Efervescente", "OTC", 19.90, 11.20, giro=2.4, validade_dias=360),
        Produto("Xarope para Tosse", "OTC", 24.90, 14.30, giro=1.7, validade_dias=360),
        Produto("Spray Nasal", "OTC", 21.90, 12.80, giro=1.5, validade_dias=360),
        Produto("Antiácido", "OTC", 13.90, 7.60, giro=1.4, validade_dias=540),
        Produto("Vitamina C 1g", "Suplemento", 29.90, 16.40, giro=1.8, validade_dias=540),
        Produto("Whey Protein 900g", "Suplemento", 139.90, 92.00, giro=0.5, validade_dias=540),
        Produto("Ômega 3", "Suplemento", 59.90, 36.20, giro=0.7, validade_dias=540),
        Produto("Protetor Solar FPS 50", "Dermocosmético", 69.90, 44.10, giro=1.1, validade_dias=720),
        Produto("Hidratante Facial", "Dermocosmético", 54.90, 33.80, giro=0.8, validade_dias=720),
        Produto("Shampoo Anticaspa", "Dermocosmético", 42.90, 26.40, giro=0.9, validade_dias=720),
        Produto("Fralda Infantil M (c/40)", "Infantil", 64.90, 48.30, giro=1.6, validade_dias=1095),
        Produto("Lenço Umedecido", "Infantil", 14.90, 9.20, giro=1.4, validade_dias=1095),
        Produto("Fórmula Infantil 800g", "Infantil", 89.90, 68.10, giro=0.9, validade_dias=540),
        Produto("Álcool em Gel 500ml", "Higiene", 12.90, 7.10, giro=1.5, validade_dias=720),
        Produto("Absorvente (c/8)", "Higiene", 9.90, 6.10, giro=1.9, validade_dias=1095),
        Produto("Escova Dental", "Higiene", 11.90, 6.80, giro=1.2, validade_dias=1095),
        Produto("Termômetro Digital", "Equipamento", 39.90, 24.60, giro=0.4, validade_dias=None),
        Produto("Aparelho de Pressão", "Equipamento", 189.90, 128.00, giro=0.2, validade_dias=None),
        Produto("Teste de Glicemia (c/50)", "Equipamento", 79.90, 52.40, giro=0.6, validade_dias=540),
    ),
    formas_pagamento=(
        ("Convênio / PBM", 0.29), ("Crédito", 0.25), ("Pix", 0.23),
        ("Débito", 0.17), ("Dinheiro", 0.06),
    ),
    despesas=(
        ("Folha de pagamento", 52000), ("Aluguel", 14000), ("Energia elétrica", 6800),
        ("Fornecedores - distribuidoras", 186000), ("Impostos", 23000),
        ("Sistema e licenças", 2400), ("Água", 1100), ("Manutenção", 2000),
    ),
    itens_por_cupom=(1, 5),
    cor="#0e7490",
    telas_extras=("validade",),
)


NEGOCIOS: dict[str, Negocio] = {
    PADARIA.chave: PADARIA,
    SUPERMERCADO.chave: SUPERMERCADO,
    FARMACIA.chave: FARMACIA,
}
