"""
Gera PDFs de numerario ficticios em exemplos/numerarios/, um para cada modelo de rotulo que
o robo reconhece, mais dois casos de erro (PDF sem total reconhecivel e arquivo sem referencia
no nome). Despachante, processos e valores sao inventados.

Uso: python exemplos/gerar_numerarios.py
"""

from pathlib import Path

from fpdf import FPDF

PASTA = Path(__file__).resolve().parent / "numerarios"

# (arquivo, titulo, despesas, rotulo do total ou None)
NUMERARIOS = [
    ("IMP 1101 - NUMERARIO.pdf", "NUMERÁRIO DE DESEMBARAÇO",
     [("II", 41250.00), ("IPI", 18930.40), ("PIS", 6912.15), ("COFINS", 31855.70), ("ICMS", 22410.00),
      ("Armazenagem", 3820.00), ("Honorários", 1450.00)], "TOTAL DO NUMERÁRIO R$"),
    ("IMP 1102 - NUMERARIO.pdf", "DEMONSTRATIVO DE IMPOSTOS E DESPESAS",
     [("Impostos federais", 58410.22), ("ICMS", 14980.00), ("AFRMM", 2105.33), ("Despesas portuárias", 4120.00)],
     "TOTAL IMPOSTOS + DESPESAS R$"),
    ("IMP-RO 1103 - NUMERARIO.pdf", "AVISO DE DEPÓSITO",
     [("Tributos", 96214.80), ("Taxa Siscomex", 154.23), ("Capatazia", 2980.00)], "Valor a depositar: R$"),
    ("IMP 1104B - SOLICITACAO.pdf", "SOLICITAÇÃO DE NUMERÁRIO",
     [("Sub-Total impostos", 70120.55), ("Sub-Total despesas", 6880.00)], "TOTAL GERAL R$"),
    ("IMP 1105 - DESPESAS.pdf", "RELAÇÃO DE DESPESAS",
     [("Tributos", 133402.10), ("Frete rodoviário", 5600.00), ("Armazenagem", 7210.40)], "Total Geral de Despesas"),
    ("IMP 1106 - NUMERARIO.pdf", "PRÉVIA DE NUMERÁRIO", [("II", 22100.00), ("IPI", 9800.00)], None),
    ("numerario sem referencia.pdf", "NUMERÁRIO DE DESEMBARAÇO", [("II", 1000.00)], "TOTAL DO NUMERÁRIO R$"),
]


def br(valor):
    return f"{valor:,.2f}".translate(str.maketrans(",.", ".,"))


def gerar(arquivo, titulo, despesas, rotulo_total):
    pdf = FPDF()
    pdf.add_page()
    pdf.set_font("Helvetica", "B", 13)
    pdf.cell(0, 8, "DESPACHANTE EXEMPLO LTDA", new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, "Documento fictício para demonstração", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)
    pdf.set_font("Helvetica", "B", 12)
    pdf.cell(0, 8, titulo, new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Helvetica", "", 10)
    pdf.cell(0, 6, f"Processo: {arquivo.split(' - ')[0]}", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)
    for item, valor in despesas:
        pdf.cell(110, 6, item)
        pdf.cell(0, 6, f"R$ {br(valor)}", align="R", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)
    if rotulo_total:
        pdf.set_font("Helvetica", "B", 11)
        pdf.cell(0, 7, f"{rotulo_total} {br(sum(v for _, v in despesas))}", new_x="LMARGIN", new_y="NEXT")
    else:
        pdf.cell(0, 6, "Valores sujeitos a confirmação após o registro da declaração.", new_x="LMARGIN", new_y="NEXT")
    pdf.output(str(PASTA / arquivo))


if __name__ == "__main__":
    PASTA.mkdir(exist_ok=True)
    for numerario in NUMERARIOS:
        gerar(*numerario)
    print(f"{len(NUMERARIOS)} PDFs gravados em {PASTA}")
