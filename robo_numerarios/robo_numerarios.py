"""
Robo de numerarios de desembaraco: PDF do despachante -> aba "Numerarios de desembaraco".

O QUE FAZ
---------
1. Le todos os PDFs de numerario da pasta configurada.
2. Para cada PDF, extrai:
     - a referencia do processo, a partir do NOME DO ARQUIVO (ex.: "IMP 1374 - NUMERARIO.pdf");
     - o valor total a pagar, procurando no texto do PDF um destes rotulos, nesta ordem:
       "TOTAL DO NUMERARIO", "TOTAL IMPOSTOS + DESPESAS", "Valor a depositar:",
       "TOTAL GERAL", "Total Geral de Despesas". Cada despachante usa um modelo.
3. Compara com o que ja esta na aba (pela referencia) e so grava o que falta, sem duplicar.
4. Cada linha recebe um status:
     - "Extraido"         leitura ok, valor confiavel;
     - "Erro: <motivo>"   o valor fica em branco. O robo nunca estima um numero: quem decide
                          o que fazer com um erro e uma pessoa, conferindo o PDF.
   Linhas com erro sao tentadas de novo na proxima execucao.

O relatorio de provisionamento le essa aba e troca a estimativa pelo valor real assim que ele
aparece com status "Extraido".

USO
---
Ver o que seria feito, sem gravar nada:
    python robo_numerarios.py --dry-run

Ler outra pasta e gravar o resultado num CSV, sem Google Sheets (usado na demonstracao):
    python robo_numerarios.py --pasta ../exemplos/numerarios --csv numerarios.csv

Rodar de verdade (le a pasta configurada e grava na planilha):
    python robo_numerarios.py

Configuracao em config_numerarios.json, na mesma pasta (modelo em config_numerarios.exemplo.json).
Para gravar na planilha: conta de servico do Google Cloud com a Google Sheets API ativada e a
planilha compartilhada com o e-mail dela como Editor.
"""

import argparse
import csv
import glob
import json
import os
import re
import sys
import unicodedata

import pdfplumber

PASTA = os.path.dirname(os.path.abspath(__file__))
ARQ_CONFIG = os.path.join(PASTA, "config_numerarios.json")

CONFIG_PADRAO = {
    "pasta_numerarios": "",
    "planilha_id": "",
    "aba_destino": "Numerários de desembaraço",
    "credenciais_json": "credenciais_google.json",
    # Prefixos das referencias internas. Aceita sufixo de filial ("IMP-RO 1374")
    # e letra no fim do numero ("IMP 1602B").
    "prefixos_referencia": ["IMP"],
}

PADROES_VALOR_TOTAL = [
    re.compile(r'TOTAL\s+DO\s+NUMER[ÁA]RIO\s*R\$\s*([\d.\s]+,\d{2})', re.IGNORECASE),
    re.compile(r'TOTAL\s+IMPOSTOS\s*\+\s*DESPESAS\s*R?\$?\s*([\d.\s]+,\d{2})', re.IGNORECASE),
    re.compile(r'VALOR\s+A\s+DEPOSITAR\s*:?\s*R?\$?\s*([\d.\s]+,\d{2})', re.IGNORECASE),
    # Modelo "SOLICITACAO DE NUMERARIO": o \b antes de TOTAL e o GERAL logo depois
    # impedem que "Sub-Total" seja lido no lugar do total.
    re.compile(r'\bTOTAL\s+GERAL\s*R?\$?\s*([\d.\s]+,\d{2})', re.IGNORECASE),
    # Modelo sem "R$": "Total Geral de Despesas 253.076,86"
    re.compile(r'\bTOTAL\s+GERAL\s+DE\s+DESPESAS\s*:?\s*R?\$?\s*([\d.\s]+,\d{2})', re.IGNORECASE),
]


def carregar_config():
    cfg = dict(CONFIG_PADRAO)
    if os.path.exists(ARQ_CONFIG):
        with open(ARQ_CONFIG, encoding="utf-8") as f:
            cfg.update(json.load(f))
    return cfg


def regex_referencia(prefixos):
    grupo = "|".join(re.escape(p) for p in prefixos)
    return re.compile(r'\b((?:%s)(?:-[A-Z]{2})?\s?\d+[A-Z]?)\b' % grupo, re.IGNORECASE)


def normalizar(s):
    s = (s or '').strip().upper()
    s = ''.join(c for c in unicodedata.normalize('NFKD', s) if not unicodedata.combining(c))
    return re.sub(r'\s+', ' ', s)


def extrair_referencia_do_nome(caminho_arquivo, regex):
    nome = os.path.splitext(os.path.basename(caminho_arquivo))[0]
    m = regex.search(nome)
    return normalizar(m.group(1)) if m else None


def extrair_valor_total(texto):
    for padrao in PADROES_VALOR_TOTAL:
        m = padrao.search(texto)
        if m:
            valor_str = m.group(1).replace(' ', '').replace('.', '').replace(',', '.')
            try:
                return round(float(valor_str), 2)
            except ValueError:
                continue
    return None


def processar_pdf(caminho_arquivo, regex):
    nome_arquivo = os.path.basename(caminho_arquivo)
    referencia = extrair_referencia_do_nome(caminho_arquivo, regex)
    if not referencia:
        return {'referencia': nome_arquivo, 'valor': None,
                'status': 'Erro: nao foi possivel identificar a referencia pelo nome do arquivo'}
    try:
        with pdfplumber.open(caminho_arquivo) as pdf:
            texto = '\n'.join(p.extract_text() or '' for p in pdf.pages)
    except Exception as e:
        return {'referencia': referencia, 'valor': None, 'status': 'Erro: falha ao abrir/ler o PDF (%s)' % e}
    valor = extrair_valor_total(texto)
    if valor is None:
        return {'referencia': referencia, 'valor': None,
                'status': 'Erro: nao encontrou nenhum padrao de valor total conhecido no texto do PDF'}
    return {'referencia': referencia, 'valor': valor, 'status': 'Extraído'}


def conectar_planilha(cfg):
    # Import local: --dry-run e --csv funcionam sem gspread instalado
    import gspread
    from google.oauth2.service_account import Credentials

    credenciais = Credentials.from_service_account_file(
        os.path.join(PASTA, cfg["credenciais_json"]), scopes=['https://www.googleapis.com/auth/spreadsheets'])
    planilha = gspread.authorize(credenciais).open_by_key(cfg["planilha_id"])
    try:
        aba = planilha.worksheet(cfg["aba_destino"])
    except gspread.WorksheetNotFound:
        aba = planilha.add_worksheet(title=cfg["aba_destino"], rows=1000, cols=3)
        aba.update('A1:C1', [['Referência', 'Valor Total', 'Status']])
    return aba


def carregar_estado_planilha(aba):
    """Devolve {referencia_normalizada: {'linha': N, 'status': status_normalizado}}.

    So "Extraido" conta como resolvido: uma linha com erro e tentada de novo na proxima
    execucao, em vez de ficar presa para sempre com o erro antigo."""
    estado = {}
    for i, row in enumerate(aba.get_all_values()[1:], start=2):
        ref = row[0] if len(row) > 0 else ''
        status = row[2] if len(row) > 2 else ''
        if ref:
            estado[normalizar(ref)] = {'linha': i, 'status': normalizar(status)}
    return estado


def ler_pasta(arquivos, estado, regex):
    """Processa os PDFs que ainda nao estao resolvidos. Devolve (novas_linhas, atualizacoes)."""
    novas_linhas, atualizacoes = [], []
    for caminho in arquivos:
        referencia_check = normalizar(extrair_referencia_do_nome(caminho, regex) or os.path.basename(caminho))
        existente = estado.get(referencia_check)
        if existente and existente['status'] == 'EXTRAIDO':
            print('  [ja existe]  %-20s (%s)' % (referencia_check, os.path.basename(caminho)))
            continue

        resultado = processar_pdf(caminho, regex)
        linha_valores = [resultado['referencia'], '' if resultado['valor'] is None else resultado['valor'],
                         resultado['status']]
        marca = 'OK' if resultado['status'] == 'Extraído' else 'ERRO'
        if existente:
            atualizacoes.append((existente['linha'], linha_valores))
            marca += ', nova tentativa'
        else:
            novas_linhas.append(linha_valores)
        print('  [%s]  %-20s valor=%s | %s' % (marca, resultado['referencia'], resultado['valor'], resultado['status']))
        estado[referencia_check] = {'linha': None, 'status': normalizar(resultado['status'])}
    return novas_linhas, atualizacoes


def main():
    cfg = carregar_config()
    parser = argparse.ArgumentParser(description='Le PDFs de numerario e grava o valor total na planilha.')
    parser.add_argument('--pasta', default=cfg["pasta_numerarios"], help='Pasta com os PDFs.')
    parser.add_argument('--dry-run', action='store_true', help='So mostra o que seria feito, nao grava nada.')
    parser.add_argument('--csv', help='Grava o resultado neste CSV em vez da planilha do Google.')
    args = parser.parse_args()

    if not args.pasta or not os.path.isdir(args.pasta):
        sys.exit('ERRO: pasta nao encontrada: %r. Informe --pasta ou preencha config_numerarios.json.' % args.pasta)

    arquivos = sorted(glob.glob(os.path.join(args.pasta, '*.pdf')))
    if not arquivos:
        print('Nenhum PDF encontrado em: %s' % args.pasta)
        return

    regex = regex_referencia(cfg["prefixos_referencia"])
    aba = None
    if args.dry_run or args.csv:
        estado = {}
        print('Lendo %d PDF(s) sem gravar na planilha do Google:\n' % len(arquivos))
    else:
        aba = conectar_planilha(cfg)
        estado = carregar_estado_planilha(aba)
        resolvidas = sum(1 for v in estado.values() if v['status'] == 'EXTRAIDO')
        print('%d referencia(s) ja extraidas (nao serao duplicadas); %d com erro anterior (serao tentadas de novo).'
              % (resolvidas, len(estado) - resolvidas))

    novas_linhas, atualizacoes = ler_pasta(arquivos, estado, regex)

    if args.csv:
        with open(args.csv, 'w', newline='', encoding='utf-8') as f:
            escritor = csv.writer(f)
            escritor.writerow(['Referência', 'Valor Total', 'Status'])
            escritor.writerows(novas_linhas)
        print('\n%d linha(s) gravada(s) em %s.' % (len(novas_linhas), args.csv))
        return
    if not novas_linhas and not atualizacoes:
        print('\nNenhum numerario novo nem pendente de correcao.')
        return
    if args.dry_run:
        print('\n[--dry-run] %d linha(s) seriam adicionadas e %d atualizadas.' % (len(novas_linhas), len(atualizacoes)))
        return

    for linha_num, valores in atualizacoes:
        aba.update('A%d:C%d' % (linha_num, linha_num), [valores], value_input_option='USER_ENTERED')
    if atualizacoes:
        print('%d linha(s) com erro anterior foram tentadas de novo.' % len(atualizacoes))
    if novas_linhas:
        aba.append_rows(novas_linhas, value_input_option='USER_ENTERED')
        print('%d numerario(s) novo(s) adicionado(s) na aba "%s".' % (len(novas_linhas), cfg["aba_destino"]))


if __name__ == '__main__':
    main()
