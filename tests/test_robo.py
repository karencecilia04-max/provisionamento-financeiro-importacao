import csv
from pathlib import Path

import pytest

from gerar_numerarios import NUMERARIOS
from robo_numerarios import (extrair_referencia_do_nome, extrair_valor_total, ler_pasta, processar_pdf,
                             regex_referencia)

RAIZ = Path(__file__).resolve().parents[1]
PASTA_PDFS = RAIZ / "exemplos" / "numerarios"
REGEX = regex_referencia(["IMP"])


@pytest.mark.parametrize("nome, esperado", [
    ("IMP 1374 - NUMERARIO.pdf", "IMP 1374"),
    ("imp1374 numerario.pdf", "IMP1374"),
    ("IMP-RO 1374 - NUMERARIO.pdf", "IMP-RO 1374"),
    ("IMP 1602B - SOLICITACAO.pdf", "IMP 1602B"),
    ("numerario sem referencia.pdf", None),
])
def test_referencia_pelo_nome_do_arquivo(nome, esperado):
    assert extrair_referencia_do_nome(nome, REGEX) == esperado


def test_prefixos_de_referencia_configuraveis():
    regex = regex_referencia(["PRC", "LOG"])
    assert extrair_referencia_do_nome("PRC 0042 - numerario.pdf", regex) == "PRC 0042"
    assert extrair_referencia_do_nome("LOG-SP 1804.pdf", regex) == "LOG-SP 1804"


@pytest.mark.parametrize("texto, esperado", [
    ("TOTAL DO NUMERÁRIO R$ 126.628,25", 126628.25),
    ("TOTAL IMPOSTOS + DESPESAS R$ 79.615,55", 79615.55),
    ("Valor a depositar: R$ 99.349,03", 99349.03),
    ("TOTAL GERAL R$ 77.000,55", 77000.55),
    ("Total Geral de Despesas 253.076,86", 253076.86),
    ("TOTAL DO NUMERARIO R$ 1 234,50", 1234.50),
])
def test_valor_total_nos_modelos_de_cada_despachante(texto, esperado):
    assert extrair_valor_total(texto) == esperado


def test_sub_total_nao_e_lido_como_total():
    texto = "Sub-Total impostos R$ 70.120,55\nSub-Total despesas R$ 6.880,00\nTOTAL GERAL R$ 77.000,55"
    assert extrair_valor_total(texto) == 77000.55


def test_sem_total_reconhecivel_nao_inventa_valor():
    assert extrair_valor_total("II R$ 22.100,00\nIPI R$ 9.800,00") is None


@pytest.mark.parametrize("arquivo, titulo, despesas, rotulo", NUMERARIOS)
def test_pdfs_de_exemplo(arquivo, titulo, despesas, rotulo):
    resultado = processar_pdf(str(PASTA_PDFS / arquivo), REGEX)
    if rotulo and resultado["referencia"] != arquivo:
        assert resultado["status"] == "Extraído"
        assert resultado["valor"] == round(sum(v for _, v in despesas), 2)
    else:
        assert resultado["status"].startswith("Erro")
        assert resultado["valor"] is None


def test_nao_duplica_extraidos_e_tenta_de_novo_os_com_erro():
    arquivos = sorted(str(p) for p in PASTA_PDFS.glob("*.pdf"))
    estado = {"IMP 1101": {"linha": 2, "status": "EXTRAIDO"}, "IMP 1106": {"linha": 3, "status": "ERRO: X"}}
    novas, atualizacoes = ler_pasta(arquivos, estado, REGEX)
    assert "IMP 1101" not in [l[0] for l in novas]
    assert [(n, v[0]) for n, v in atualizacoes] == [(3, "IMP 1106")]


def test_csv_de_exemplo_e_o_que_o_robo_gera():
    arquivos = sorted(str(p) for p in PASTA_PDFS.glob("*.pdf"))
    novas, _ = ler_pasta(arquivos, {}, REGEX)
    with open(RAIZ / "exemplos" / "numerarios_lidos.csv", encoding="utf-8") as f:
        salvas = list(csv.reader(f))[1:]
    assert [[str(c) for c in l] for l in novas] == salvas
