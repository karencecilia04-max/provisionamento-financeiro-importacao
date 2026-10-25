// Testes do RelatorioProvisionamento.gs rodando na planilha simulada com os dados fictícios.
// Rodar: node --test tests/relatorio.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { rodarRoteiro } from '../previa/roteiro.mjs';

const COTACAO = 5.42;

// Linhas de um bloco da aba FINANCEIRO, a partir do título até a linha em branco
function bloco(planilha, titulo) {
  const aba = planilha.getSheetByName('FINANCEIRO');
  const valores = aba.getRange(1, 1, aba.getLastRow(), 11).getValues();
  const inicio = valores.findIndex(l => String(l[0]).startsWith(titulo));
  assert.ok(inicio >= 0, `bloco ${titulo} não encontrado`);
  const linhas = [];
  for (let i = inicio + 3; i < valores.length && valores[i][1] !== ''; i++) linhas.push({ linha: i + 1, valores: valores[i] });
  return { aba, linhas, soma: valores[inicio + 2] };
}

const porProcesso = linhas => Object.fromEntries(linhas.map(l => [l.valores[1], l]));

test('desembaraço usa o numerário lido pelo robô e estima o resto', () => {
  const { planilha } = rodarRoteiro();
  const d = porProcesso(bloco(planilha, '3. DESEMBARAÇO').linhas);

  assert.equal(d['IMP 1101'].valores[6], 126628.25);
  assert.equal(d['IMP 1101'].valores[8], 'Real (numerário)');
  assert.equal(d['IMP-RO 1103'].valores[8], 'Real (numerário)');
  // Numerário com erro de leitura: volta para a estimativa (antidumping, 89%)
  assert.equal(d['IMP 1106'].valores[8], 'Estimado (%)');
  assert.ok(Math.abs(d['IMP 1106'].valores[6] - 41000 * COTACAO * 0.89) < 0.01);
  // Antidumping com pneu de passeio (99%) e 3 containers (+15% por container extra)
  assert.ok(Math.abs(d['IMP 1107'].valores[6] - 30000 * COTACAO * 0.99 * 1.30) < 0.01);
  // Padrão de 75%
  assert.ok(Math.abs(d['IMP 1108'].valores[6] - 27500 * COTACAO * 0.75) < 0.01);
  // Já desembaraçado (coluna AL preenchida): fora do bloco
  assert.equal(d['IMP 1109'], undefined);
});

test('câmbio já pago ou com CAMBIO PREVISAO não entra na antecipação', () => {
  const { planilha } = rodarRoteiro();
  const a = porProcesso(bloco(planilha, '1. ANTECIPAÇÃO').linhas);
  assert.deepEqual(Object.keys(a).sort(), ['IMP 1110', 'IMP 1111', 'IMP 1112']);
});

test('valor em reais não é convertido; em dólar, é convertido pela cotação', () => {
  const { planilha } = rodarRoteiro();
  const a = porProcesso(bloco(planilha, '1. ANTECIPAÇÃO').linhas);
  assert.equal(a['IMP 1112'].valores[9], 118400);
  assert.ok(Math.abs(a['IMP 1110'].valores[9] - 15600 * COTACAO) < 0.01);
});

test('pagamento antes do início do período ganha a data ajustada para a segunda-feira do fluxo', () => {
  const { planilha, inicio } = rodarRoteiro();
  const a = porProcesso(bloco(planilha, '1. ANTECIPAÇÃO').linhas);
  const ajustada = a['IMP 1111'].valores[10];
  assert.equal(ajustada.getTime(), new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + 2).getTime());
  assert.equal(a['IMP 1110'].valores[10], '');
});

test('exportador em destaque fica em laranja claro', () => {
  const { planilha } = rodarRoteiro();
  const { aba, linhas } = bloco(planilha, '2. SALDO');
  const linha = porProcesso(linhas)['IMP 1115'].linha;
  assert.equal(aba.celula(linha, 1).fundo, '#ffe0b3');
});

test('previsão de faturamento soma 7 dias para encomenda e 14 para importação própria', () => {
  const { planilha } = rodarRoteiro();
  const f = porProcesso(bloco(planilha, '4. PREVISÃO').linhas.map(l => ({ ...l, valores: ['', ...l.valores] })));
  const dias = ref => Math.round((f[ref].valores[4] - f[ref].valores[3]) / 86400000);
  assert.equal(dias('IMP 1118'), 7);
  assert.equal(dias('IMP 1119'), 14);
});

test('resumo por equipe fecha com a soma dos blocos', () => {
  const { planilha } = rodarRoteiro();
  const aba = planilha.getSheetByName('FINANCEIRO');
  const valores = aba.getRange(1, 1, aba.getLastRow(), 5).getValues();
  const total = valores.find(l => l[0] === 'TOTAL GERAL');
  const somas = ['1. ANTECIPAÇÃO', '2. SALDO', '3. DESEMBARAÇO'].map(t => bloco(planilha, t).soma);
  assert.ok(Math.abs(total[1] - somas[0][9]) < 0.01);
  assert.ok(Math.abs(total[2] - somas[1][9]) < 0.01);
  assert.ok(Math.abs(total[3] - somas[2][6]) < 0.01);
  assert.ok(Math.abs(total[4] - (total[1] + total[2] + total[3])) < 0.01);
});

test('taxa manual substitui a cotação automática', () => {
  const { planilha } = rodarRoteiro({ taxaManual: 6 });
  const a = porProcesso(bloco(planilha, '1. ANTECIPAÇÃO').linhas);
  assert.ok(Math.abs(a['IMP 1110'].valores[9] - 15600 * 6) < 0.01);
  assert.equal(planilha.getSheetByName('FINANCEIRO').getRange('F6').getValue(), 'taxa em uso (simulação)');
});

test('filtro de importação própria deixa só esses processos', () => {
  const { planilha } = rodarRoteiro({ filtro: 'IMP PROPRIA' });
  const d = porProcesso(bloco(planilha, '3. DESEMBARAÇO').linhas);
  assert.deepEqual(Object.keys(d).sort(), ['IMP 1102', 'IMP 1107']);
});
