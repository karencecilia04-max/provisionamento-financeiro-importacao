// Planilha do Google simulada em memória, para rodar o RelatorioProvisionamento.gs fora do Google.
// Imita só o que o script usa: valores, fórmula da cotação, formatos de número, cores, células
// mescladas e regras de formatação condicional.

import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export function letraParaColuna(letras) {
  return [...letras].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}

export function colunaParaLetra(n) {
  let s = '';
  for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
  return s;
}

// Datas criadas dentro do script vêm de outro contexto do Node: instanceof Date não serve
export function ehData(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

const dois = n => String(n).padStart(2, '0');
const milhar = (v, casas) => v.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });

export function formatar(v, formato) {
  if (v === undefined || v === null || v === '') return '';
  if (ehData(v)) return `${dois(v.getDate())}/${dois(v.getMonth() + 1)}/${v.getFullYear()}`;
  if (typeof v !== 'number') return String(v);
  if (formato === '"R$" #,##0.00') return `R$ ${milhar(v, 2)}`;
  if (formato === '#,##0.00') return milhar(v, 2);
  if (formato === '0.0000') return milhar(v, 4);
  if (formato === '0') return String(Math.round(v));
  return milhar(v, Number.isInteger(v) ? 0 : 2);
}

function encadeavel(alvo) {
  // Métodos que não mudam o que a prévia mostra (bordas, notas, altura) devolvem o próprio objeto
  const proxy = new Proxy(alvo, { get: (o, nome) => (nome in o ? o[nome] : () => proxy) });
  return proxy;
}

class Intervalo {
  constructor(aba, linha, coluna, nLinhas, nColunas) {
    Object.assign(this, { aba, linha, coluna, nLinhas, nColunas });
    return encadeavel(this);
  }

  cada(f) {
    for (let i = 0; i < this.nLinhas; i++) {
      for (let j = 0; j < this.nColunas; j++) f(this.aba.celula(this.linha + i, this.coluna + j), i, j);
    }
    return this;
  }

  matriz(f) {
    return Array.from({ length: this.nLinhas }, (_, i) =>
      Array.from({ length: this.nColunas }, (_, j) => f(this.aba.celula(this.linha + i, this.coluna + j))));
  }

  aplicar(propriedade, valor) { return this.cada(c => { c[propriedade] = valor; }); }

  getValues() { return this.matriz(c => (c.v === undefined ? '' : c.v)); }
  getValue() { return this.getValues()[0][0]; }
  getDisplayValues() { return this.matriz(c => formatar(c.v, c.formato)); }
  setValues(valores) { return this.cada((c, i, j) => { c.v = valores[i][j]; }); }
  setValue(v) { return this.aplicar('v', v); }
  setFormula(f) {
    const cotacao = /GOOGLEFINANCE/.test(f) ? this.aba.planilha.cotacao : '';
    return this.cada(c => { c.formula = f; c.v = cotacao; });
  }
  setBackground(cor) { return this.aplicar('fundo', cor); }
  setFontColor(cor) { return this.aplicar('cor', cor); }
  setFontWeight(peso) { return this.aplicar('negrito', peso === 'bold'); }
  setFontStyle(estilo) { return this.aplicar('italico', estilo === 'italic'); }
  setFontSize(tamanho) { return this.aplicar('tamanho', tamanho); }
  setHorizontalAlignment(a) { return this.aplicar('alinhamento', a); }
  setNumberFormat(f) { return this.aplicar('formato', f); }
  setDataValidation(regra) { return this.aplicar('lista', regra && regra.valores); }
  setNote(nota) { return this.aplicar('nota', nota); }
  merge() {
    this.aba.mesclas.push({ linha: this.linha, coluna: this.coluna, nLinhas: this.nLinhas, nColunas: this.nColunas });
    return this;
  }
}

class Aba {
  constructor(planilha, nome) {
    Object.assign(this, { planilha, nome, celulas: new Map(), larguras: {}, alturas: {}, mesclas: [], regras: [],
                          cor: null, congeladas: 0 });
    return encadeavel(this);
  }

  celula(l, c) {
    const chave = `${l},${c}`;
    if (!this.celulas.has(chave)) this.celulas.set(chave, {});
    return this.celulas.get(chave);
  }

  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const [ini, fim] = a.split(':');
      const ler = ref => { const m = ref.match(/^([A-Z]+)(\d+)$/); return [Number(m[2]), letraParaColuna(m[1])]; };
      const [l1, c1] = ler(ini);
      const [l2, c2] = fim ? ler(fim) : [l1, c1];
      return new Intervalo(this, l1, c1, l2 - l1 + 1, c2 - c1 + 1);
    }
    return new Intervalo(this, a, b, c || 1, d || 1);
  }

  ultimo(indice) {
    let maior = 0;
    for (const [chave, c] of this.celulas) {
      if (c.v !== undefined && c.v !== '' && c.v !== null) maior = Math.max(maior, Number(chave.split(',')[indice]));
    }
    return maior;
  }

  getLastRow() { return this.ultimo(0); }
  getLastColumn() { return this.ultimo(1); }
  getMaxRows() { return 1000; }
  getMaxColumns() { return 26; }
  getName() { return this.nome; }
  getSheetId() { return 0; }
  setTabColor(cor) { this.cor = cor; return this; }
  setColumnWidth(col, largura) { this.larguras[col] = largura; return this; }
  setRowHeight(linha, altura) { this.alturas[linha] = altura; return this; }
  setFrozenRows(n) { this.congeladas = n; return this; }
  getProtections() { return []; }
  getImages() { return []; }
  getConditionalFormatRules() { return this.regras.slice(); }
  setConditionalFormatRules(regras) { this.regras = regras; return this; }
  clear() { this.celulas.clear(); this.mesclas = []; return this; }
  clearConditionalFormatRules() { this.regras = []; return this; }
}

class Planilha {
  constructor(cotacao) { Object.assign(this, { abas: [], avisos: [], cotacao }); }
  getSheetByName(nome) { return this.abas.find(a => a.nome === nome) || null; }
  getSheets() { return this.abas; }
  insertSheet(nome) { const aba = new Aba(this, nome); this.abas.push(aba); return aba; }
  getId() { return 'planilha-ficticia'; }
}

function construtor(campos) {
  const valor = {};
  const obj = {};
  for (const [metodo, chave] of Object.entries(campos)) obj[metodo] = v => { valor[chave] = v; return obj; };
  obj.build = () => valor;
  return obj;
}

// Carrega o RelatorioProvisionamento.gs num contexto com a planilha simulada
export function carregarRelatorio(arquivoGs, { cotacao = 5.42 } = {}) {
  const planilha = new Planilha(cotacao);
  const contexto = vm.createContext({
    console,
    Logger: { log() {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => planilha,
      getUi: () => ({ alert: msg => planilha.avisos.push(msg), createMenu: () => encadeavel({}) }),
      newDataValidation: () => construtor({ requireValueInList: 'valores', setAllowInvalid: 'invalido' }),
      newConditionalFormatRule: () => construtor({
        whenFormulaSatisfied: 'formula', setBackground: 'fundo', setRanges: 'intervalos' }),
      ProtectionType: { RANGE: 'range', SHEET: 'sheet' },
      BorderStyle: { SOLID: 'solid' },
      flush() {},
    },
    Utilities: { sleep() {} },
  });
  vm.runInContext(readFileSync(arquivoGs, 'utf8'), contexto);
  return { planilha, relatorio: contexto };
}
