// Gera a prévia visual do relatório: roda o RelatorioProvisionamento.gs com dados fictícios e
// desenha as abas num HTML com a aparência do Google Sheets.
//
// Antes, gere a aba de numerários com o robô:
//   python robo_numerarios/robo_numerarios.py --pasta exemplos/numerarios --csv exemplos/numerarios_lidos.csv
// Depois: node previa/gerar_previa.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { colunaParaLetra, ehData, formatar } from './planilha_simulada.mjs';
import { rodarRoteiro } from './roteiro.mjs';

const SAIDA = new URL('saida/', import.meta.url);
const LARGURA_PADRAO = 100;

const escapar = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Regras condicionais do relatório: "=F36<HOJE()" pinta a data que já passou, "=F36=HOJE()" a de hoje
function corCondicional(aba, linha, coluna, valor, hoje) {
  for (const regra of aba.regras) {
    const r = regra.intervalos[0];
    const dentro = linha >= r.linha && linha < r.linha + r.nLinhas && coluna >= r.coluna && coluna < r.coluna + r.nColunas;
    if (!dentro || !ehData(valor)) continue;
    const dia = new Date(valor.getFullYear(), valor.getMonth(), valor.getDate()).getTime();
    if (regra.formula.includes('<HOJE()') && dia < hoje.getTime()) return regra.fundo;
    if (regra.formula.includes('=HOJE()') && dia === hoje.getTime()) return regra.fundo;
  }
  return null;
}

function desenharAba(aba, nLinhas, nColunas, hoje) {
  const mescla = new Map();
  const coberta = new Set();
  for (const m of aba.mesclas) {
    mescla.set(`${m.linha},${m.coluna}`, m);
    for (let i = 0; i < m.nLinhas; i++) {
      for (let j = 0; j < m.nColunas; j++) if (i || j) coberta.add(`${m.linha + i},${m.coluna + j}`);
    }
  }
  const colunas = Array.from({ length: nColunas }, (_, i) => i + 1);
  const largura = c => aba.larguras[c] || LARGURA_PADRAO;
  const total = 40 + colunas.reduce((s, c) => s + largura(c), 0);
  const cab = colunas.map(c => `<th style="width:${largura(c)}px">${colunaParaLetra(c)}</th>`).join('');

  const corpo = Array.from({ length: nLinhas }, (_, i) => i + 1).map(l => {
    const tds = colunas.filter(c => !coberta.has(`${l},${c}`)).map(c => {
      const cel = aba.celulas.get(`${l},${c}`) || {};
      const m = mescla.get(`${l},${c}`);
      const fundo = corCondicional(aba, l, c, cel.v, hoje) || cel.fundo;
      const numero = typeof cel.v === 'number' || ehData(cel.v);
      const estilo = [
        fundo && `background:${fundo}`,
        cel.cor && `color:${cel.cor}`,
        cel.negrito && 'font-weight:700',
        cel.italico && 'font-style:italic',
        cel.tamanho && `font-size:${Math.round(cel.tamanho * 1.3)}px`,
        `text-align:${cel.alinhamento || (numero ? 'right' : 'left')}`,
      ].filter(Boolean).join(';');
      const vizinha = (aba.celulas.get(`${l},${c + 1}`) || {}).v;
      // Só texto passa por cima das células vazias ao lado; número e data ficam na própria célula
      const classe = [m || vizinha || numero ? 'corta' : 'vaza', cel.lista && 'lista'].filter(Boolean).join(' ');
      const span = m ? ` colspan="${m.nColunas}"` : '';
      return `<td${span} class="${classe}" style="${estilo}"><div>${escapar(formatar(cel.v, cel.formato))}</div></td>`;
    });
    const altura = aba.alturas[l] ? ` style="height:${aba.alturas[l]}px"` : '';
    return `<tr${altura}><th class="num">${l}</th>${tds.join('')}</tr>`;
  });
  return `<table style="width:${total}px"><thead><tr><th class="canto"></th>${cab}</tr></thead><tbody>${corpo.join('')}</tbody></table>`;
}

function pagina(planilha, ativa, nColunas, hoje) {
  const aba = planilha.getSheetByName(ativa);
  const nLinhas = aba.getLastRow() + 2;
  const abas = planilha.getSheets().map(a =>
    `<span class="aba${a.nome === ativa ? ' ativa' : ''}" style="border-bottom-color:${a.cor || 'transparent'}">${escapar(a.nome)}</span>`);
  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><title>${escapar(ativa)} - Provisionamento</title>
<style>
  body { margin: 0 0 48px; font-family: Arial, sans-serif; font-size: 13px; color: #202124; background: #fff; }
  .topo { display: flex; align-items: center; gap: 12px; padding: 10px 16px 0; }
  .icone { width: 26px; height: 34px; background: #188038; border-radius: 3px; }
  .titulo { font-size: 18px; }
  .menus { padding: 4px 54px 8px; color: #444; }
  .menus span { margin-right: 14px; }
  .menus .proprio { font-weight: 700; color: #188038; }
  .barra { height: 34px; background: #edf2fa; margin: 0 8px; border-radius: 18px; }
  .grade { overflow: hidden; border-top: 1px solid #c7c7c7; margin-top: 8px; }
  table { border-collapse: collapse; table-layout: fixed; }
  th { background: #f8f9fa; color: #5f6368; font-weight: 400; font-size: 11px; border: 1px solid #c7c7c7; height: 20px; }
  th.canto, th.num { width: 40px; }
  td { border: 1px solid #e2e2e2; padding: 0; height: 21px; vertical-align: middle; position: relative; }
  td div { padding: 2px 4px; white-space: nowrap; overflow: hidden; }
  td.vaza div { position: absolute; left: 0; top: 0; bottom: 0; display: flex; align-items: center; overflow: visible; z-index: 1; }
  td.lista div::after { content: ""; position: absolute; right: 6px; top: 9px; border: 4px solid transparent; border-top-color: #5f6368; }
  .abas { position: fixed; bottom: 0; left: 0; right: 0; background: #f8f9fa; border-top: 1px solid #c7c7c7; padding: 6px 12px; }
  .aba { display: inline-block; padding: 6px 14px; margin-right: 2px; border-bottom: 3px solid transparent; color: #444; }
  .aba.ativa { background: #e1e9f7; color: #0b57d0; font-weight: 700; border-radius: 4px 4px 0 0; }
</style></head><body>
<div class="topo"><div class="icone"></div><div class="titulo">Provisionamento financeiro <span style="color:#5f6368;font-size:14px">(prévia com dados fictícios)</span></div></div>
<div class="menus"><span>Arquivo</span><span>Editar</span><span>Ver</span><span>Inserir</span><span>Formatar</span><span>Dados</span><span>Ferramentas</span><span>Extensões</span><span>Ajuda</span><span class="proprio">Provisionamento</span></div>
<div class="barra"></div>
<div class="grade">${desenharAba(aba, nLinhas, nColunas, hoje)}</div>
<div class="abas">${abas.join('')}</div>
</body></html>`;
}

const { planilha, hoje } = rodarRoteiro();
mkdirSync(SAIDA, { recursive: true });
// A aba FINANCEIRO vem primeiro, como na planilha de verdade depois de gerar o relatório
planilha.abas.sort((a, b) => (a.nome === 'FINANCEIRO' ? -1 : b.nome === 'FINANCEIRO' ? 1 : 0));
writeFileSync(new URL('financeiro.html', SAIDA), pagina(planilha, 'FINANCEIRO', 11, hoje));
writeFileSync(new URL('numerarios.html', SAIDA), pagina(planilha, 'Numerários de desembaraço', 4, hoje));
console.log(`Prévia gravada em ${fileURLToPath(SAIDA)}`);
