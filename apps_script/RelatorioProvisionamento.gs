/**
 * RELATÓRIO DE PROVISIONAMENTO FINANCEIRO
 *
 * Monta a aba FINANCEIRO com todos os pagamentos de importação previstos para o próximo fluxo
 * financeiro (gerado toda semana), a partir do follow-up da aba Consolidado:
 *   1. Antecipação de câmbio: data em BC no período e BD vazia (ainda não pago). Processos com
 *      "CAMBIO PREVISAO" na coluna H ficam de fora.
 *   2. Saldo de câmbio: data em BH no período e BI vazia.
 *   3. Desembaraço aduaneiro: chegada (N) no período e AL vazia (ainda não desembaraçado).
 *      Usa o numerário real do despachante quando ele já foi lido pelo robô de numerários
 *      (aba "Numerários de desembaraço", status "Extraído"). Sem numerário, estima um
 *      percentual sobre o FOB em reais: 75% no padrão, 82% para pneu de passeio, 89% com
 *      antidumping, 99% com os dois, e +15% para cada container além do primeiro.
 *   4. Previsão de faturamento: chegada + 7 dias (por encomenda e conta e ordem) ou + 14 dias
 *      (importação própria) dentro do período.
 * Um resumo por equipe soma os três primeiros blocos em reais.
 *
 * Período: por padrão, do próximo sábado ao sábado seguinte. Pagamentos entre hoje e o início
 * do período também entram, marcados em azul com a data ajustada para a segunda-feira do fluxo.
 *
 * Campos editáveis no topo da aba, preservados entre uma geração e outra:
 *   D3/F3  início e fim do período;
 *   E5     filtro pela modalidade (coluna F);
 *   E6     taxa manual, para simular outra cotação no lugar da automática do Google Finance (E4).
 *
 * Valores em dólar (coluna T = USD) são convertidos pela taxa em uso; em reais, ficam como estão.
 *
 * Instalar: na planilha, Extensões > Apps Script, colar este arquivo e salvar. Rodar uma vez a
 * função gerarRelatorioProvisionamento para autorizar e recarregar a planilha: aparece o menu
 * Provisionamento.
 */

var SOURCE_SHEET_NAME = 'Consolidado';
var REPORT_SHEET_NAME = 'FINANCEIRO';
var NUMERARIOS_SHEET_NAME = 'Numerários de desembaraço';
var STATUS_PREVISAO = 'CAMBIO PREVISAO';

// ---- Provisionamento de Desembaraço Aduaneiro (usado só quando o processo
// ainda não tem numerário real extraído na aba NUMERARIOS_SHEET_NAME) ----
var PCT_DESEMBARACO_BASE = 0.75;
var PCT_DESEMBARACO_DUMPING = 0.89;
var PCT_DESEMBARACO_PNEU_PASSAGEIRO = 0.82;
var PCT_ACRESCIMO_DUMPING_MAIS_PNEU_PASSAGEIRO = 0.10; // percentual de variação do II quando DUMPING e Pneu passageiro ocorrem juntos
var INCREMENTO_POR_CONTAINER_ADICIONAL = 0.15; // +15% no total por container além do 1º

// ---- Destaque visual por exportador (coluna K) nos blocos de Antecipação/Saldo ----
// Exportadores que pedem atenção no fluxo (ex.: exigem pagamento antecipado). As linhas deles
// ficam em laranja claro. Escreva os nomes como aparecem na coluna K.
var EXPORTADORES_DESTAQUE = [];

function ehExportadorDestaque(nome) {
  var alvo = normalizarTexto(nome);
  return EXPORTADORES_DESTAQUE.some(function (e) { return normalizarTexto(e) === alvo; });
}

// ---- Previsão de Faturamento: prazo (em dias) após a Data de Chegada, varia pela
// modalidade de importação (coluna F) ----
var DIAS_FATURAMENTO_PADRAO = 7;       // Por Encomenda / Por Encomenda/Distribuidora / Conta e Ordem
var DIAS_FATURAMENTO_IMP_PROPRIA = 14; // Imp. Própria (e variações)

// ---- Filtro por tipo de operação (coluna F da Consolidado) ----
var FILTRO_TODOS = 'TODOS';
var FILTRO_ENCOMENDA_CONTA_ORDEM = 'ENCOMENDA + CONTA E ORDEM';
var FILTRO_IMP_PROPRIA = 'IMP PROPRIA';
var FILTRO_ENCOMENDA_DISTRIBUIDORA = 'Por Encomenda/Distribuidora';
var OPCOES_FILTRO = [FILTRO_TODOS, FILTRO_ENCOMENDA_CONTA_ORDEM, FILTRO_IMP_PROPRIA, FILTRO_ENCOMENDA_DISTRIBUIDORA];

// Remove acentos e caixa para comparar o texto da coluna F sem depender de
// exatamente como o usuário escreveu (ex.: "Impo. Própria" vs "IMPO PROPRIA").
function normalizarTexto(s) {
  var t = (s || '').toString().toUpperCase().trim();
  var comAcento = 'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ';
  var semAcento = 'AAAAAEEEEIIIIOOOOOUUUUC';
  var resultado = '';
  for (var i = 0; i < t.length; i++) {
    var ch = t.charAt(i);
    var idx = comAcento.indexOf(ch);
    resultado += (idx !== -1) ? semAcento.charAt(idx) : ch;
  }
  return resultado;
}

function processoPassaNoFiltro(tipoOperacaoColunaF, filtroSelecionado) {
  if (filtroSelecionado === FILTRO_ENCOMENDA_CONTA_ORDEM) {
    return tipoOperacaoColunaF.indexOf('ENCOMENDA') !== -1 || tipoOperacaoColunaF.indexOf('CONTA E ORDEM') !== -1;
  }
  if (filtroSelecionado === FILTRO_IMP_PROPRIA) {
    return tipoOperacaoColunaF.indexOf('PROPRIA') !== -1;
  }
  if (filtroSelecionado === FILTRO_ENCOMENDA_DISTRIBUIDORA) {
    // "seja igual ao status" -> comparação exata (após normalizar acento/caixa), não substring
    return tipoOperacaoColunaF === normalizarTexto(FILTRO_ENCOMENDA_DISTRIBUIDORA);
  }
  return true; // FILTRO_TODOS (ou qualquer valor inesperado) -> não filtra
}

// Moeda da coluna T: considera USD qualquer variação de escrita ("USD", "US$", "Dólar"...);
// qualquer outra coisa (em branco, "R$", "BRL", "Real") é tratada como já estando em reais.
function ehMoedaUSD(moeda) {
  var m = normalizarTexto(moeda);
  return m.indexOf('USD') !== -1 || m.indexOf('DOLAR') !== -1 || m === 'US$';
}

// Converte um valor para reais: se a moeda (coluna T) for USD, multiplica pela
// taxa cambial em uso (automática do Google Finance ou manual, à escolha do
// analista); se já estiver em reais, devolve o valor original sem conversão.
function converterParaReais(valor, moeda, taxa) {
  return ehMoedaUSD(moeda) ? (valor || 0) * taxa : (valor || 0);
}

// Considera "vazia" uma célula sem valor (string vazia, null ou undefined),
// que é como o Google Sheets devolve uma célula em branco via getValues().
function celulaVazia(v) {
  return v === '' || v === null || v === undefined;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Provisionamento')
    .addItem('Atualizar relatório', 'gerarRelatorioProvisionamento')
    .addItem('Baixar Excel', 'baixarRelatorioExcel')
    .addToUi();
}

/**
 * Abre uma janela com o link direto de download da aba FINANCEIRO em Excel (.xlsx).
 * Ligada ao item de menu "Baixar Excel".
 */
function baixarRelatorioExcel() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(REPORT_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('Gere o relatório antes de baixar.');
    return;
  }
  var url = 'https://docs.google.com/spreadsheets/d/' + ss.getId() +
    '/export?format=xlsx&gid=' + sheet.getSheetId();
  var html = HtmlService.createHtmlOutput(
    '<div style="font-family:Arial, sans-serif; text-align:center; padding:16px;">' +
    '<p style="margin-bottom:16px;">Clique no botão abaixo para baixar o relatório em Excel:</p>' +
    '<a href="' + url + '" target="_blank" ' +
    'style="display:inline-block; padding:12px 24px; background:#eb6834; color:#14213d; ' +
    'font-weight:bold; text-decoration:none; border-radius:8px;">Baixar Excel (.xlsx)</a>' +
    '</div>'
  ).setWidth(340).setHeight(150);
  SpreadsheetApp.getUi().showModalDialog(html, 'Download do Relatório');
}

/**
 * Ponto de entrada, ligado ao item de menu "Atualizar relatório".
 */
function gerarRelatorioProvisionamento() {
  try {
    montarRelatorio();
  } catch (err) {
    SpreadsheetApp.getUi().alert(
      'Ocorreu um erro ao gerar o relatório:\n\n' + err.message +
      '\n\nTente novamente em alguns segundos ' +
      '(pode ser uma instabilidade temporária da cotação do Google Finance).'
    );
  }
}

function montarRelatorio() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var source = ss.getSheetByName(SOURCE_SHEET_NAME);
  if (!source) throw new Error('Aba "' + SOURCE_SHEET_NAME + '" não encontrada.');

  // ---- Numerários reais de desembaraço (alimentada por robô externo que lê
  // os PDFs do despachante), quando a referência aparece aqui com status
  // "Extraído", o valor real tem prioridade sobre a estimativa por percentual.
  var numerariosPorRef = {};
  var numerariosSheet = ss.getSheetByName(NUMERARIOS_SHEET_NAME);
  if (numerariosSheet) {
    var numLastRow = numerariosSheet.getLastRow();
    if (numLastRow >= 2) {
      var numDados = numerariosSheet.getRange(2, 1, numLastRow - 1, 3).getValues(); // A=Referência, B=Valor Total, C=Status
      numDados.forEach(function (r) {
        var refNorm = normalizarTexto(r[0]);
        if (!refNorm) return;
        numerariosPorRef[refNorm] = { valor: r[1], status: normalizarTexto(r[2]) };
      });
    }
  }

  var report = ss.getSheetByName(REPORT_SHEET_NAME);

  // Preserva o período, o filtro e a taxa manual já escolhidos pelo usuário, se existirem
  var periodoAnterior = null;
  var filtroAnterior = null;
  var taxaManualAnterior = null;
  if (report) {
    var iniAntigo = report.getRange('D3').getValue();
    var fimAntigo = report.getRange('F3').getValue();
    if (iniAntigo instanceof Date && fimAntigo instanceof Date) {
      periodoAnterior = { inicio: iniAntigo, fim: fimAntigo };
    }
    var filtroAntigoValor = report.getRange('E5').getValue();
    if (OPCOES_FILTRO.indexOf(filtroAntigoValor) !== -1) {
      filtroAnterior = filtroAntigoValor;
    }
    var taxaManualAntigaValor = report.getRange('E6').getValue();
    if (typeof taxaManualAntigaValor === 'number' && !isNaN(taxaManualAntigaValor) && taxaManualAntigaValor > 0) {
      taxaManualAnterior = taxaManualAntigaValor;
    }
    // Remove qualquer proteção deixada por uma versão antiga do script, para
    // que a aba fique sempre livre para qualquer pessoa editar. Cada remoção
    // é isolada em try/catch só por segurança (proteção de outro criador
    // eventualmente ainda presente não pode travar a geração do relatório).
    var protecoesAntigas = report.getProtections(SpreadsheetApp.ProtectionType.RANGE)
      .concat(report.getProtections(SpreadsheetApp.ProtectionType.SHEET));
    protecoesAntigas.forEach(function (p) {
      try { p.remove(); } catch (eRemoveProtecaoAntiga) {
        Logger.log('Não foi possível remover proteção antiga: ' + eRemoveProtecaoAntiga);
      }
    });
    report.clear();
    report.clearFormats();
    report.clearConditionalFormatRules();
    // Evita que uma mesclagem de uma execução anterior (em posição que
    // mudou porque a quantidade de equipes/processos mudou) colida com
    // as novas mesclagens e quebre o setValues() no meio do processo.
    try {
      report.getRange(1, 1, report.getMaxRows(), report.getMaxColumns()).breakApart();
    } catch (eBreak) { /* nada para desfazer */ }
  } else {
    report = ss.insertSheet(REPORT_SHEET_NAME);
  }

  report.setHiddenGridlines(true);
  report.setTabColor('#eb6834');

  // ---- Larguras de coluna fixas (A a J, usadas tanto pelo cabeçalho quanto pelas tabelas) ----
  var larguras = [100, 100, 190, 110, 110, 120, 110, 100, 140, 130];
  larguras.forEach(function (w, i) { report.setColumnWidth(i + 1, w); });

  // ---- Período padrão: próximo sábado -> sábado seguinte ----
  var hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  var diaSemana = hoje.getDay(); // 0=domingo ... 6=sábado
  var diasAteSabado = (6 - diaSemana + 7) % 7;
  var inicioPadrao = new Date(hoje.getTime());
  inicioPadrao.setDate(hoje.getDate() + diasAteSabado);
  var fimPadrao = new Date(inicioPadrao.getTime());
  fimPadrao.setDate(inicioPadrao.getDate() + 7);

  var inicio = periodoAnterior ? periodoAnterior.inicio : inicioPadrao;
  var fim = periodoAnterior ? periodoAnterior.fim : fimPadrao;
  var filtroSelecionado = filtroAnterior || FILTRO_TODOS;
  var taxaManualPreenchida = taxaManualAnterior; // null se em branco/ inválida

  function normalizarData(d) {
    if (!(d instanceof Date)) return null;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  var dIni = normalizarData(inicio);
  var dFim = normalizarData(fim);

  // ---- Exceção: pagamentos entre HOJE e o início oficial do período ----
  var dBuscaIni = (hoje < dIni) ? hoje : dIni;
  var dataAjustadaPadrao = new Date(dIni.getTime());
  dataAjustadaPadrao.setDate(dIni.getDate() + 2); // segunda-feira após o início do período

  // =========================================================
  // CABEÇALHO: título na linha 1, informações e campos editáveis nas linhas 2 a 6
  // =========================================================
  report.setRowHeight(1, 42);
  report.setRowHeight(2, 24);
  report.setRowHeight(3, 24);
  report.setRowHeight(4, 24);
  report.setRowHeight(5, 24);
  report.setRowHeight(6, 24);
  report.setRowHeight(7, 8);

  // Faixa clara atrás das informações
  report.getRange('A2:H6').setBackground('#f3f3f8');

  report.getRange('A1:H1').merge().setValue('RELATÓRIO DE PROVISIONAMENTO FINANCEIRO')
    .setFontWeight('bold').setFontSize(15).setFontColor('#ffffff')
    .setBackground('#14213d').setHorizontalAlignment('center').setVerticalAlignment('middle');

  report.getRange('C2').setValue('Última Atualização:').setFontWeight('bold').setHorizontalAlignment('right');
  report.getRange('D2').setValue(new Date()).setNumberFormat('dd/mm/yyyy').setHorizontalAlignment('center');

  report.getRange('C3').setValue('Data Início:').setFontWeight('bold').setHorizontalAlignment('right');
  report.getRange('D3').setValue(inicio).setNumberFormat('dd/mm/yyyy').setHorizontalAlignment('center')
    .setBackground('#fff2cc').setNote('Editável: digite a data de início do período.');
  report.getRange('E3').setValue('Data Fim:').setFontWeight('bold').setHorizontalAlignment('right');
  report.getRange('F3').setValue(fim).setNumberFormat('dd/mm/yyyy').setHorizontalAlignment('center')
    .setBackground('#fff2cc').setNote('Editável: digite a data de fim do período.');

  report.getRange('C4:D4').merge().setValue('Taxa Cambial do Dia (USD/BRL):')
    .setFontWeight('bold').setHorizontalAlignment('right');
  var taxaCell = report.getRange('E4');
  taxaCell.setHorizontalAlignment('center');
  taxaCell.setFormula('=GOOGLEFINANCE("CURRENCY:USDBRL")');
  taxaCell.setNumberFormat('0.0000').setBackground('#e6f2ff').setFontWeight('bold')
    .setNote('Cotação automática do Google Finance (dólar em reais). Se a Taxa Manual (linha abaixo) estiver preenchida, ela é usada no lugar desta.');

  report.getRange('C5:D5').merge().setValue('Filtro (Coluna F):')
    .setFontWeight('bold').setHorizontalAlignment('right');
  var filtroCell = report.getRange('E5:G5').merge();
  filtroCell.setValue(filtroSelecionado).setHorizontalAlignment('center').setFontWeight('bold')
    .setBackground('#fff2cc')
    .setNote('Editável: escolha TODOS, ENCOMENDA + CONTA E ORDEM, IMP PROPRIA ou Por Encomenda/Distribuidora. Filtra os processos pela coluna F da aba Consolidado.');
  var regraFiltro = SpreadsheetApp.newDataValidation()
    .requireValueInList(OPCOES_FILTRO, true)
    .setAllowInvalid(false)
    .build();
  filtroCell.setDataValidation(regraFiltro);

  report.getRange('C6:D6').merge().setValue('Taxa Manual (simulação):')
    .setFontWeight('bold').setHorizontalAlignment('right');
  var taxaManualCell = report.getRange('E6');
  taxaManualCell.setValue(taxaManualPreenchida || '').setHorizontalAlignment('center')
    .setNumberFormat('0.0000').setBackground('#fff2cc')
    .setNote('Opcional: preencha para simular com uma taxa diferente da automática (ex.: testar cenários). Deixe em branco para usar a cotação automática do Google Finance.');

  // Faixa colorida encerrando o cabeçalho
  report.getRange('A7:H7').setBackground('#eb6834');

  SpreadsheetApp.flush();
  Utilities.sleep(800);
  var taxaCambial = taxaCell.getValue();
  if (typeof taxaCambial !== 'number' || isNaN(taxaCambial) || taxaCambial <= 0) {
    SpreadsheetApp.flush();
    Utilities.sleep(1500);
    taxaCambial = taxaCell.getValue();
  }
  var avisoTaxaCambial = null;
  if (typeof taxaCambial !== 'number' || isNaN(taxaCambial) || taxaCambial <= 0) {
    taxaCambial = 1;
    avisoTaxaCambial = 'Não foi possível obter a cotação do dólar via Google Finance agora. ' +
      'Os valores de desembaraço foram calculados com taxa = 1 temporariamente, gere o relatório novamente em alguns segundos.';
  }

  // Taxa efetivamente usada nos cálculos: a manual (se preenchida) tem prioridade
  // sobre a automática, permite ao analista simular cenários com outra cotação.
  var taxaCambialFinal = taxaManualPreenchida || taxaCambial;
  report.getRange('F6').setValue(taxaManualPreenchida ? 'taxa em uso (simulação)' : '')
    .setFontStyle('italic').setFontColor('#b45f06').setHorizontalAlignment('left');


  // ---- Lê todos os dados da aba Consolidado (colunas A até BH) ----
  var lastRow = source.getLastRow();
  var dados = source.getRange(2, 1, Math.max(lastRow - 1, 0), 61).getValues();

  var antecipacao = [], saldo = [], desembaraco = [], previsaoFaturamento = [];

  dados.forEach(function (row) {
    var tipoOperacao = normalizarTexto(row[5]); // F: Por Encomenda / Conta e Ordem / Impo. Própria / Por Encomenda/Distribuidora
    if (!processoPassaNoFiltro(tipoOperacao, filtroSelecionado)) return;

    var equipe = row[0];          // A
    var processo = row[1];        // B
    var status = (row[7] || '').toString().toUpperCase(); // H
    var statusNormalizadoH = normalizarTexto(row[7]); // H, sem acento, usado no percentual de Desembaraço (DUMPING / Pneu passageiro)
    var cliente = row[3];         // D
    var exportador = row[10];     // K: usado em Antecipação de Câmbio/Saldo de Câmbio
    var embarque = row[12];       // M
    var chegada = row[13];        // N
    var moeda = row[19];           // T: moeda dos valores abaixo (USD ou já em reais), vale para todos os blocos
    var valorFobU = row[20];       // U: valor FOB, usado só no Desembaraço Aduaneiro
    var valorReaisFob = converterParaReais(valorFobU, moeda, taxaCambialFinal);
    var valorAntecipacaoBB = row[53]; // BB: valor da Antecipação de Câmbio
    var valorReaisAntecipacao = converterParaReais(valorAntecipacaoBB, moeda, taxaCambialFinal);
    var valorSaldoBG = row[58];    // BG: valor do Saldo de Câmbio
    var valorReaisSaldo = converterParaReais(valorSaldoBG, moeda, taxaCambialFinal);
    var dataAntecipacao = normalizarData(row[54]); // BC: data do primeiro pagamento
    var bdVazia = celulaVazia(row[55]);            // BD: só entra em Antecipação se estiver vazia (ainda não pago)
    var dataSaldo = normalizarData(row[59]);       // BH: data do saldo
    var biVazia = celulaVazia(row[60]);            // BI: só entra em Saldo se estiver vazia (ainda não pago)
    var alVazia = celulaVazia(row[37]);            // AL: só entra em Desembaraço se estiver vazia (ainda não desembaraçado)
    var chegadaNorm = normalizarData(chegada);

    // Processos com "CAMBIO PREVISAO" na coluna H não entram mais em nenhum
    // painel (o painel "Previsão de Prontidão" foi removido do relatório).
    if (dataAntecipacao && bdVazia && status.indexOf(STATUS_PREVISAO) === -1 &&
        dataAntecipacao >= dBuscaIni && dataAntecipacao <= dFim) {
      var foraPeriodo1 = dataAntecipacao < dIni;
      antecipacao.push([equipe, processo, cliente, exportador, embarque, chegada, row[54], valorAntecipacaoBB || 0, moeda || '', valorReaisAntecipacao,
        foraPeriodo1 ? dataAjustadaPadrao : '', foraPeriodo1]);
    }
    if (dataSaldo && biVazia && dataSaldo >= dBuscaIni && dataSaldo <= dFim) {
      var foraPeriodo2 = dataSaldo < dIni;
      saldo.push([equipe, processo, cliente, exportador, embarque, chegada, row[59], valorSaldoBG || 0, moeda || '', valorReaisSaldo,
        foraPeriodo2 ? dataAjustadaPadrao : '', foraPeriodo2]);
    }
    if (chegadaNorm && alVazia && chegadaNorm >= dBuscaIni && chegadaNorm <= dFim) {
      var foraPeriodo3 = chegadaNorm < dIni;
      var qtdContainersBruta = row[24]; // Y: quantidade de containers do processo
      var qtdContainers = (typeof qtdContainersBruta === 'number' && qtdContainersBruta >= 1) ? qtdContainersBruta : 1;

      var numerarioReal = numerariosPorRef[normalizarTexto(processo)];
      var valorDesembaraco, origemDesembaraco;
      if (numerarioReal && numerarioReal.status.indexOf('EXTRAIDO') !== -1 && typeof numerarioReal.valor === 'number' && numerarioReal.valor > 0) {
        // Numerário real já lido pelo robô a partir do PDF do despachante, tem
        // prioridade sobre a estimativa por percentual (já vem pronto em R$).
        valorDesembaraco = numerarioReal.valor;
        origemDesembaraco = 'Real (numerário)';
      } else {
        // Ainda sem numerário real (ou com erro de leitura) -> estima por
        // percentual sobre o FOB em reais. DUMPING e Pneu passageiro mudam o
        // percentual base; cada container além do 1º soma +15% ao total.
        var temDumping = statusNormalizadoH.indexOf('DUMPING') !== -1;
        var temPneuPassageiro = statusNormalizadoH.indexOf('PNEU PASSAGEIRO') !== -1;
        var percentualDesembaraco = PCT_DESEMBARACO_BASE;
        if (temDumping && temPneuPassageiro) {
          percentualDesembaraco = PCT_DESEMBARACO_DUMPING + PCT_ACRESCIMO_DUMPING_MAIS_PNEU_PASSAGEIRO;
        } else if (temDumping) {
          percentualDesembaraco = PCT_DESEMBARACO_DUMPING;
        } else if (temPneuPassageiro) {
          percentualDesembaraco = PCT_DESEMBARACO_PNEU_PASSAGEIRO;
        }
        var fatorContainer = 1 + INCREMENTO_POR_CONTAINER_ADICIONAL * (qtdContainers - 1);
        valorDesembaraco = valorReaisFob * percentualDesembaraco * fatorContainer;
        origemDesembaraco = 'Estimado (%)';
      }

      desembaraco.push([equipe, processo, cliente, embarque, chegada, chegada, valorDesembaraco, qtdContainers, origemDesembaraco,
        foraPeriodo3 ? dataAjustadaPadrao : '', foraPeriodo3]);
    }
    if (chegadaNorm) {
      // Imp. Própria (e variações "Impo. Própria"/"Importação Própria") fatura mais
      // devagar que Encomenda/Conta e Ordem, mesmo critério de substring usado no
      // filtro FILTRO_IMP_PROPRIA (tipoOperacao já vem normalizado, sem acento/caixa).
      var diasParaFaturamento = tipoOperacao.indexOf('PROPRIA') !== -1
        ? DIAS_FATURAMENTO_IMP_PROPRIA
        : DIAS_FATURAMENTO_PADRAO;
      var dataFaturamento = new Date(chegadaNorm.getTime());
      dataFaturamento.setDate(dataFaturamento.getDate() + diasParaFaturamento);
      if (dataFaturamento >= dIni && dataFaturamento <= dFim) {
        previsaoFaturamento.push([processo, cliente, chegada, dataFaturamento]);
      }
    }
  });

  // =========================================================
  // RESUMO POR EQUIPE
  // =========================================================
  var equipesSet = {};
  function acumular(mapa, equipe, valor) {
    var key = equipe || '(sem equipe)';
    mapa[key] = (mapa[key] || 0) + (valor || 0);
    equipesSet[key] = true;
  }
  var totAntec = {}, totSaldo = {}, totDesemb = {};
  antecipacao.forEach(function (r) { acumular(totAntec, r[0], r[9]); }); // r[9] = valor já convertido em reais
  saldo.forEach(function (r) { acumular(totSaldo, r[0], r[9]); });
  desembaraco.forEach(function (r) { acumular(totDesemb, r[0], r[6]); }); // desembaraço já sai em reais (r[6])

  var equipes = Object.keys(equipesSet).sort();

  var linha = 10;
  report.getRange(linha, 1, 1, 5).merge().setValue('RESUMO POR EQUIPE')
    .setFontWeight('bold').setFontSize(12).setFontColor('#14213d')
    .setBackground('#fdeee6').setVerticalAlignment('middle');
  report.setRowHeight(linha, 28);
  linha++;
  var headerResumo = ['Equipe', 'Total Antecipação (R$)', 'Total Saldo (R$)', 'Total Desembaraço (R$)', 'Total Geral (R$)'];
  report.getRange(linha, 1, 1, headerResumo.length).setValues([headerResumo])
    .setFontWeight('bold').setBackground('#14213d').setFontColor('#ffffff').setVerticalAlignment('middle');
  report.setRowHeight(linha, 24);
  linha++;
  var inicioResumo = linha;
  var somaAntecGeral = 0, somaSaldoGeral = 0, somaDesembGeral = 0;
  equipes.forEach(function (eq, idx) {
    var a = totAntec[eq] || 0, s = totSaldo[eq] || 0, d = totDesemb[eq] || 0;
    somaAntecGeral += a; somaSaldoGeral += s; somaDesembGeral += d;
    var totalGeralBRL = a + s + d; // todos os valores já estão em reais
    report.getRange(linha, 1, 1, 5).setValues([[eq, a, s, d, totalGeralBRL]])
      .setBackground(idx % 2 === 0 ? '#ffffff' : '#f6f7fb');
    linha++;
  });
  var totalGeralGeralBRL = somaAntecGeral + somaSaldoGeral + somaDesembGeral;
  report.getRange(linha, 1, 1, 5).setValues([[
    'TOTAL GERAL', somaAntecGeral, somaSaldoGeral, somaDesembGeral, totalGeralGeralBRL
  ]]).setFontWeight('bold').setBackground('#eb6834').setFontColor('#14213d');
  var fimResumo = linha;
  report.getRange(inicioResumo, 2, fimResumo - inicioResumo + 1, 4).setNumberFormat('"R$" #,##0.00');
  report.getRange(10, 1, fimResumo - 10 + 1, 5)
    .setBorder(true, true, true, true, true, true, '#c7c7d1', SpreadsheetApp.BorderStyle.SOLID);
  linha = fimResumo + 2;

  // =========================================================
  // BLOCOS DETALHADOS
  // =========================================================
  function escreverBlocoDesembaraco(titulo, linhasComFlag) {
    var NUM_COLS = 10;
    var headerBloco = ['Equipe', 'Processo', 'Cliente', 'Data Embarque', 'Data Chegada', 'Data Pagamento',
      'Valor Provisionado (R$)', 'Qtd. Containers', 'Origem', 'Data Ajustada'];

    var linhaTitulo = linha;
    report.getRange(linha, 1, 1, NUM_COLS).merge().setValue(titulo)
      .setFontWeight('bold').setFontSize(12).setFontColor('#14213d')
      .setBackground('#e9ecf7').setVerticalAlignment('middle');
    report.setRowHeight(linha, 26);
    linha++;
    report.getRange(linha, 1, 1, headerBloco.length).setValues([headerBloco])
      .setFontWeight('bold').setBackground('#14213d').setFontColor('#ffffff').setVerticalAlignment('middle');
    report.setRowHeight(linha, 22);
    linha++;

    var somaValor = linhasComFlag.reduce(function (acc, r) { return acc + (r[6] || 0); }, 0);
    report.getRange(linha, 1, 1, NUM_COLS).setValues([['', '', '', '', '', 'SOMA:', somaValor, '', '', '']])
      .setFontWeight('bold').setBackground('#fdeee6');
    report.getRange(linha, 7).setNumberFormat('"R$" #,##0.00');
    linha++;

    var linhaDadosInicio = linha;
    if (linhasComFlag.length > 0) {
      var linhasDados = linhasComFlag.map(function (r) { return r.slice(0, NUM_COLS); });
      report.getRange(linha, 1, linhasDados.length, NUM_COLS).setValues(linhasDados);
      report.getRange(linhaDadosInicio, 4, linhasDados.length, 3).setNumberFormat('dd/mm/yyyy');
      report.getRange(linhaDadosInicio, 7, linhasDados.length, 1).setNumberFormat('"R$" #,##0.00');
      report.getRange(linhaDadosInicio, 8, linhasDados.length, 1).setNumberFormat('0');
      report.getRange(linhaDadosInicio, 10, linhasDados.length, 1).setNumberFormat('dd/mm/yyyy');

      linhasComFlag.forEach(function (r, idx) {
        var corFundo = r[10] ? '#add8ff' : (idx % 2 === 0 ? '#ffffff' : '#f6f7fb');
        report.getRange(linhaDadosInicio + idx, 1, 1, NUM_COLS).setBackground(corFundo);
      });

      var rangeData = report.getRange(linhaDadosInicio, 6, linhasDados.length, 1);
      var rules = report.getConditionalFormatRules();
      rules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenFormulaSatisfied('=F' + linhaDadosInicio + '<HOJE()')
          .setBackground('#ff6b6b')
          .setRanges([rangeData])
          .build(),
        SpreadsheetApp.newConditionalFormatRule()
          .whenFormulaSatisfied('=F' + linhaDadosInicio + '=HOJE()')
          .setBackground('#ffb84d')
          .setRanges([rangeData])
          .build()
      );
      report.setConditionalFormatRules(rules);

      linha += linhasDados.length;
    } else {
      report.getRange(linha, 1).setValue('Nenhum processo encontrado neste período.')
        .setFontStyle('italic').setFontColor('#888888');
      linha++;
    }
    report.getRange(linhaTitulo, 1, linha - linhaTitulo, NUM_COLS)
      .setBorder(true, true, true, true, true, true, '#c7c7d1', SpreadsheetApp.BorderStyle.SOLID);
    linha += 2;
  }

  // Antecipação/Previsão/Saldo: valor original (coluna U) + moeda (coluna T) +
  // valor já convertido para reais, em vez de um único valor rotulado US$/R$.
  function escreverBlocoCambio(titulo, linhasComFlag) {
    var headerBloco = ['Equipe', 'Processo', 'Cliente', 'Exportador', 'Data Embarque', 'Data Chegada', 'Data Pagamento',
      'Valor', 'Moeda', 'Valor em R$', 'Data Ajustada'];
    var NUM_COLS = headerBloco.length;

    var linhaTitulo = linha;
    report.getRange(linha, 1, 1, NUM_COLS).merge().setValue(titulo)
      .setFontWeight('bold').setFontSize(12).setFontColor('#14213d')
      .setBackground('#e9ecf7').setVerticalAlignment('middle');
    report.setRowHeight(linha, 26);
    linha++;
    report.getRange(linha, 1, 1, NUM_COLS).setValues([headerBloco])
      .setFontWeight('bold').setBackground('#14213d').setFontColor('#ffffff').setVerticalAlignment('middle');
    report.setRowHeight(linha, 22);
    linha++;

    var somaReais = linhasComFlag.reduce(function (acc, r) { return acc + (r[9] || 0); }, 0);
    report.getRange(linha, 1, 1, NUM_COLS).setValues([['', '', '', '', '', '', 'SOMA:', '', '', somaReais, '']])
      .setFontWeight('bold').setBackground('#fdeee6');
    report.getRange(linha, 10).setNumberFormat('"R$" #,##0.00');
    linha++;

    var linhaDadosInicio = linha;
    if (linhasComFlag.length > 0) {
      var linhasDados = linhasComFlag.map(function (r) { return r.slice(0, NUM_COLS); });
      report.getRange(linha, 1, linhasDados.length, NUM_COLS).setValues(linhasDados);
      report.getRange(linhaDadosInicio, 5, linhasDados.length, 3).setNumberFormat('dd/mm/yyyy'); // embarque/chegada/pagamento
      report.getRange(linhaDadosInicio, 8, linhasDados.length, 1).setNumberFormat('#,##0.00');     // valor original
      report.getRange(linhaDadosInicio, 10, linhasDados.length, 1).setNumberFormat('"R$" #,##0.00'); // valor em reais
      report.getRange(linhaDadosInicio, 11, linhasDados.length, 1).setNumberFormat('dd/mm/yyyy');   // data ajustada

      linhasComFlag.forEach(function (r, idx) {
        var corFundo;
        if (ehExportadorDestaque(r[3])) {
          corFundo = '#ffe0b3'; // exportador em destaque: prioridade sobre o azul de "fora do período"
        } else {
          corFundo = r[11] ? '#add8ff' : (idx % 2 === 0 ? '#ffffff' : '#f6f7fb');
        }
        report.getRange(linhaDadosInicio + idx, 1, 1, NUM_COLS).setBackground(corFundo);
      });

      var rangeData = report.getRange(linhaDadosInicio, 7, linhasDados.length, 1);
      var rules = report.getConditionalFormatRules();
      rules.push(
        SpreadsheetApp.newConditionalFormatRule()
          .whenFormulaSatisfied('=G' + linhaDadosInicio + '<HOJE()')
          .setBackground('#ff6b6b')
          .setRanges([rangeData])
          .build(),
        SpreadsheetApp.newConditionalFormatRule()
          .whenFormulaSatisfied('=G' + linhaDadosInicio + '=HOJE()')
          .setBackground('#ffb84d')
          .setRanges([rangeData])
          .build()
      );
      report.setConditionalFormatRules(rules);

      linha += linhasDados.length;
    } else {
      report.getRange(linha, 1).setValue('Nenhum processo encontrado neste período.')
        .setFontStyle('italic').setFontColor('#888888');
      linha++;
    }
    report.getRange(linhaTitulo, 1, linha - linhaTitulo, NUM_COLS)
      .setBorder(true, true, true, true, true, true, '#c7c7d1', SpreadsheetApp.BorderStyle.SOLID);
    linha += 2;
  }

  // Previsão de Faturamento: processos cuja Data de Chegada (coluna N) + 7 dias
  // cai dentro do período selecionado.
  function escreverBlocoFaturamento(titulo, linhas) {
    var headerBloco = ['Processo', 'Cliente', 'Data de Chegada', 'Data Prevista de Faturamento'];
    var NUM_COLS = headerBloco.length;

    var linhaTitulo = linha;
    report.getRange(linha, 1, 1, NUM_COLS).merge().setValue(titulo)
      .setFontWeight('bold').setFontSize(12).setFontColor('#14213d')
      .setBackground('#e9ecf7').setVerticalAlignment('middle');
    report.setRowHeight(linha, 26);
    linha++;
    report.getRange(linha, 1, 1, NUM_COLS).setValues([headerBloco])
      .setFontWeight('bold').setBackground('#14213d').setFontColor('#ffffff').setVerticalAlignment('middle');
    report.setRowHeight(linha, 22);
    linha++;

    report.getRange(linha, 1, 1, NUM_COLS).setValues([['', '', 'Total de processos:', linhas.length]])
      .setFontWeight('bold').setBackground('#fdeee6');
    linha++;

    var linhaDadosInicio = linha;
    if (linhas.length > 0) {
      report.getRange(linha, 1, linhas.length, NUM_COLS).setValues(linhas);
      report.getRange(linhaDadosInicio, 3, linhas.length, 2).setNumberFormat('dd/mm/yyyy');
      linhas.forEach(function (r, idx) {
        report.getRange(linhaDadosInicio + idx, 1, 1, NUM_COLS).setBackground(idx % 2 === 0 ? '#ffffff' : '#f6f7fb');
      });
      linha += linhas.length;
    } else {
      report.getRange(linha, 1).setValue('Nenhum processo com faturamento previsto neste período.')
        .setFontStyle('italic').setFontColor('#888888');
      linha++;
    }
    report.getRange(linhaTitulo, 1, linha - linhaTitulo, NUM_COLS)
      .setBorder(true, true, true, true, true, true, '#c7c7d1', SpreadsheetApp.BorderStyle.SOLID);
    linha += 2;
  }

  escreverBlocoCambio('1. ANTECIPAÇÃO DE CÂMBIO', antecipacao);
  escreverBlocoCambio('2. SALDO DE CÂMBIO', saldo);
  escreverBlocoDesembaraco('3. DESEMBARAÇO ADUANEIRO', desembaraco);
  escreverBlocoFaturamento('4. PREVISÃO DE FATURAMENTO (Data de Chegada + 7 ou 14 dias, conforme modalidade)', previsaoFaturamento);

  // ---- Legenda ----
  var linhaLegendaTitulo = linha;
  report.getRange(linha, 1, 1, 8).merge().setValue('Legenda')
    .setFontWeight('bold').setFontColor('#14213d').setBackground('#fdeee6').setVerticalAlignment('middle');
  linha++;
  var legendas = [
    ['#ffb84d', 'Pagamento previsto para hoje'],
    ['#ff6b6b', 'Pagamento em atraso'],
    ['#add8ff', 'Fora do período oficial, data ajustada para a próxima segunda-feira (ver coluna "Data Ajustada")']
  ];
  legendas.forEach(function (item) {
    report.getRange(linha, 1).setBackground(item[0]);
    report.getRange(linha, 2, 1, 7).merge().setValue(item[1]);
    linha++;
  });
  report.getRange(linha, 2, 1, 7).merge()
    .setValue('Processos com status CAMBIO PREVISAO na Consolidado (coluna H) não entram em nenhum bloco de Antecipação de Câmbio (previstos, mas ainda não efetivados).')
    .setFontStyle('italic').setFontColor('#555555');
  linha++;
  report.getRange(linhaLegendaTitulo, 1, linha - linhaLegendaTitulo, 8)
    .setBorder(true, true, true, true, true, true, '#c7c7d1', SpreadsheetApp.BorderStyle.SOLID);

  // Mantém o cabeçalho visível ao rolar pelas tabelas
  report.setFrozenRows(7);

  var avisos = [avisoTaxaCambial].filter(function (a) { return a; });
  if (avisos.length > 0) {
    SpreadsheetApp.getUi().alert(avisos.join('\n\n'));
  } else {
    SpreadsheetApp.getUi().alert('Relatório atualizado com sucesso!');
  }
}
