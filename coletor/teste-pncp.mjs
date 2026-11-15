// Teste da API pública do PNCP (Portal Nacional de Contratações Públicas).
// Procura contratações/contratos de banca para "realização de concurso público".
// Grava o resultado em status-pncp.json. Não altera concursos.json.
import { writeFile } from "node:fs/promises";

const UA = "LumenPlanRadar/1.0 (+https://github.com/WSkywalker/lumen-radar-dados)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const hoje = new Date();
const ini = new Date(Date.now() - 7 * 86_400_000);
const CONCURSO = /concurso p[úu]blico|processo seletivo p[úu]blico/i;

async function pegar(nome, url, extrair) {
  const out = { nome, url };
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    out.status = r.status;
    const t = await r.text();
    try {
      const j = JSON.parse(t);
      out.chaves = Object.keys(j ?? {}).slice(0, 15);
      const lista = extrair(j);
      out.total_lista = lista.length;
      const achados = lista.filter((x) => CONCURSO.test(JSON.stringify(x)));
      out.com_concurso = achados.length;
      out.exemplo_campos = lista[0] ? Object.keys(lista[0]).slice(0, 40) : [];
      out.exemplos = achados.slice(0, 4).map((x) => JSON.stringify(x).slice(0, 900));
    } catch {
      out.corpo = t.slice(0, 400);
    }
  } catch (e) {
    out.erro = String(e?.cause?.code ?? e);
  }
  await sleep(1500);
  return out;
}

const res = [];
// 1) busca textual usada pelo próprio portal
for (const tipo of ["edital", "contrato", "ata"]) {
  res.push(
    await pegar(
      `busca ${tipo}`,
      `https://pncp.gov.br/api/search/?q=${encodeURIComponent('"concurso público"')}&tipos_documento=${tipo}&ordenacao=-data&pagina=1&tam_pagina=20`,
      (j) => j.items ?? j.data ?? [],
    ),
  );
}
// 2) API de consulta oficial: contratos publicados na última semana (1ª página)
res.push(
  await pegar(
    "consulta contratos",
    `https://pncp.gov.br/api/consulta/v1/contratos?dataInicial=${ymd(ini)}&dataFinal=${ymd(hoje)}&pagina=1&tamanhoPagina=500`,
    (j) => j.data ?? [],
  ),
);
// 3) contratações por dispensa (modalidade 8) e inexigibilidade (9) na semana
for (const mod of [8, 9]) {
  res.push(
    await pegar(
      `consulta contratações mod ${mod}`,
      `https://pncp.gov.br/api/consulta/v1/contratacoes/publicacao?dataInicial=${ymd(ini)}&dataFinal=${ymd(hoje)}&codigoModalidadeContratacao=${mod}&pagina=1&tamanhoPagina=50`,
      (j) => j.data ?? [],
    ),
  );
}
console.log(JSON.stringify(res, null, 1).slice(0, 4000));
await writeFile(new URL("../status-pncp.json", import.meta.url), JSON.stringify({ testado_em: new Date().toISOString(), res }, null, 1) + "\n");
