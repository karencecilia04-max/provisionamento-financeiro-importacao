// Monta uma planilha fictícia (abas Consolidado e Numerários de desembaraço) e roda o relatório.
// Cada processo existe para mostrar uma regra do relatório; as datas acompanham o dia de hoje.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { carregarRelatorio, letraParaColuna } from './planilha_simulada.mjs';

const RAIZ = new URL('..', import.meta.url);
const N_COLUNAS = 61;  // A até BI

// Campos usados pelo relatório, pela letra da coluna no follow-up
const COLUNA = {
  equipe: 'A', ref: 'B', cliente: 'D', modalidade: 'F', status: 'H', exportador: 'K', embarque: 'M', chegada: 'N',
  moeda: 'T', fob: 'U', containers: 'Y', desembaracado: 'AL', valorAntecipacao: 'BB', dataAntecipacao: 'BC',
  antecipacaoPaga: 'BD', valorSaldo: 'BG', dataSaldo: 'BH', saldoPago: 'BI',
};

// I = início do período (próximo sábado), H = hoje. Números são dias a somar.
export const PROCESSOS = [
  // Desembaraço com numerário real lido pelo robô
  { ref: 'IMP 1101', equipe: 'Equipe Azul', cliente: 'Cliente 01', modalidade: 'Por Encomenda', chegada: ['I', 1], fob: 52000, containers: 1 },
  { ref: 'IMP 1102', equipe: 'Equipe Verde', cliente: 'Cliente 02', modalidade: 'Impo. Própria', status: 'Pneu passageiro', chegada: ['I', 2], fob: 38000, containers: 2 },
  { ref: 'IMP-RO 1103', equipe: 'Equipe Laranja', cliente: 'Cliente 03', modalidade: 'Conta e Ordem', chegada: ['I', 3], fob: 45500, containers: 1 },
  { ref: 'IMP 1104B', equipe: 'Equipe Azul', cliente: 'Cliente 04', modalidade: 'Por Encomenda', chegada: ['I', 4], fob: 31000, containers: 1 },
  { ref: 'IMP 1105', equipe: 'Equipe Verde', cliente: 'Cliente 05', modalidade: 'Por Encomenda/Distribuidora', chegada: ['I', 5], fob: 61000, containers: 2 },
  // Sem numerário real: estimativa por percentual
  { ref: 'IMP 1106', equipe: 'Equipe Laranja', cliente: 'Cliente 06', modalidade: 'Por Encomenda', status: 'DUMPING', chegada: ['I', 2], fob: 41000, containers: 1 },
  { ref: 'IMP 1107', equipe: 'Equipe Azul', cliente: 'Cliente 07', modalidade: 'Impo. Própria', status: 'DUMPING / Pneu passageiro', chegada: ['I', 6], fob: 30000, containers: 3 },
  { ref: 'IMP 1108', equipe: 'Equipe Verde', cliente: 'Cliente 08', modalidade: 'Por Encomenda', chegada: ['H', 0], fob: 27500, containers: 1 },
  { ref: 'IMP 1109', equipe: 'Equipe Laranja', cliente: 'Cliente 09', modalidade: 'Por Encomenda', chegada: ['I', 3], fob: 33000, containers: 1, desembaracado: ['H', -1] },
  // Antecipação de câmbio
  { ref: 'IMP 1110', equipe: 'Equipe Azul', cliente: 'Cliente 10', exportador: 'Exportador 02', embarque: ['I', 20], valorAntecipacao: 15600, dataAntecipacao: ['I', 2] },
  { ref: 'IMP 1111', equipe: 'Equipe Verde', cliente: 'Cliente 11', exportador: 'Exportador 04', embarque: ['I', 25], valorAntecipacao: 9800, dataAntecipacao: ['H', 0] },
  { ref: 'IMP 1112', equipe: 'Equipe Laranja', cliente: 'Cliente 12', exportador: 'Exportador 05', embarque: ['I', 30], moeda: 'BRL', valorAntecipacao: 118400, dataAntecipacao: ['I', 5] },
  { ref: 'IMP 1113', equipe: 'Equipe Azul', cliente: 'Cliente 13', exportador: 'Exportador 06', status: 'CAMBIO PREVISAO', valorAntecipacao: 20000, dataAntecipacao: ['I', 3] },
  { ref: 'IMP 1114', equipe: 'Equipe Verde', cliente: 'Cliente 14', exportador: 'Exportador 07', valorAntecipacao: 12000, dataAntecipacao: ['I', 1], antecipacaoPaga: ['H', -2] },
  // Saldo de câmbio
  { ref: 'IMP 1115', equipe: 'Equipe Laranja', cliente: 'Cliente 15', exportador: 'Exportador 02', embarque: ['H', -20], chegada: ['I', 10], valorSaldo: 48200, dataSaldo: ['I', 4] },
  { ref: 'IMP 1116', equipe: 'Equipe Azul', cliente: 'Cliente 16', exportador: 'Exportador 08', embarque: ['H', -15], chegada: ['I', 12], valorSaldo: 31750, dataSaldo: ['I', 6] },
  { ref: 'IMP 1117', equipe: 'Equipe Verde', cliente: 'Cliente 17', exportador: 'Exportador 09', embarque: ['H', -18], chegada: ['I', 14], valorSaldo: 27300, dataSaldo: ['H', 1] },
  // Previsão de faturamento (chegada antes do período, faturamento dentro dele)
  { ref: 'IMP 1118', equipe: 'Equipe Laranja', cliente: 'Cliente 18', modalidade: 'Por Encomenda', chegada: ['I', -5], desembaracado: ['I', -3] },
  { ref: 'IMP 1119', equipe: 'Equipe Azul', cliente: 'Cliente 19', modalidade: 'Impo. Própria', chegada: ['I', -10], desembaracado: ['I', -8] },
];

export const EXPORTADOR_EM_DESTAQUE = 'Exportador 02';

function inicioDoPeriodo(hoje) {
  // Próximo sábado sempre depois de hoje, para a prévia mostrar também os pagamentos anteriores ao período
  const dias = (6 - hoje.getDay() + 7) % 7 || 7;
  return new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate() + dias);
}

export function rodarRoteiro({ hoje = new Date(), filtro = null, taxaManual = null } = {}) {
  const { planilha, relatorio } = carregarRelatorio(new URL('apps_script/RelatorioProvisionamento.gs', RAIZ));
  // Datas criadas com o Date do script, que testa instanceof Date
  const DataScript = vm.runInContext('Date', relatorio);
  const base = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const inicio = inicioDoPeriodo(base);
  const data = ([ref, dias]) => {
    const d = ref === 'I' ? inicio : base;
    return new DataScript(d.getFullYear(), d.getMonth(), d.getDate() + dias);
  };

  const consolidado = planilha.insertSheet('Consolidado');
  const cabecalho = new Array(N_COLUNAS).fill('');
  Object.entries(COLUNA).forEach(([campo, letra]) => { cabecalho[letraParaColuna(letra) - 1] = campo; });
  const linhas = PROCESSOS.map(p => {
    const linha = new Array(N_COLUNAS).fill('');
    const valores = { moeda: 'USD', exportador: 'Exportador 01', ...p };
    // Embarque cerca de 38 dias antes da chegada, quando não informado
    if (p.chegada && !p.embarque) valores.embarque = [p.chegada[0], p.chegada[1] - 38];
    for (const [campo, valor] of Object.entries(valores)) {
      linha[letraParaColuna(COLUNA[campo]) - 1] = Array.isArray(valor) ? data(valor) : valor;
    }
    return linha;
  });
  consolidado.getRange(1, 1, 1, N_COLUNAS).setValues([cabecalho]);
  consolidado.getRange(2, 1, linhas.length, N_COLUNAS).setValues(linhas);

  // Aba que o robô de numerários alimenta (aqui, a partir do CSV que ele gravou)
  const numerarios = planilha.insertSheet('Numerários de desembaraço');
  const csv = readFileSync(new URL('exemplos/numerarios_lidos.csv', RAIZ), 'utf8').trim().split(/\r?\n/)
    .map(l => l.split(','));
  numerarios.getRange(1, 1, csv.length, 3).setValues(csv.map((l, i) =>
    i && l[1] !== '' ? [l[0], Number(l[1]), l[2]] : l));

  // Período fixo a partir do próximo sábado (o relatório preserva D3 e F3 entre gerações)
  const financeiro = planilha.insertSheet('FINANCEIRO');
  financeiro.getRange('D3').setValue(data(['I', 0]));
  financeiro.getRange('F3').setValue(data(['I', 7]));
  if (filtro) financeiro.getRange('E5').setValue(filtro);
  if (taxaManual) financeiro.getRange('E6').setValue(taxaManual);

  vm.runInContext(`EXPORTADORES_DESTAQUE = ['${EXPORTADOR_EM_DESTAQUE}'];`, relatorio);
  relatorio.gerarRelatorioProvisionamento();
  return { planilha, relatorio, inicio, hoje: base };
}
