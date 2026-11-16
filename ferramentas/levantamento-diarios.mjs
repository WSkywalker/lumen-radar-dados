// Levantamento dos Diários Oficiais estaduais: endereço responde? robots.txt
// permite? a página fala em busca/pesquisa? publica em PDF? Resultado em
// status-diarios.json. Não coleta concursos.
import { writeFile } from "node:fs/promises";

const UA = "LumenPlanRadar/1.0 (levantamento; +https://github.com/WSkywalker/lumen-radar-dados)";
const DIARIOS = {
  AC: "https://www.diario.ac.gov.br/", AL: "https://www.imprensaoficial.al.gov.br/", AP: "https://diofe.portal.ap.gov.br/",
  AM: "https://diario.imprensaoficial.am.gov.br/", BA: "https://dool.egba.ba.gov.br/", CE: "https://www.imprensaoficial.ce.gov.br/",
  DF: "https://dodf.df.gov.br/", ES: "https://ioes.dio.es.gov.br/", GO: "https://diariooficial.abc.go.gov.br/",
  MA: "https://www.diariooficial.ma.gov.br/", MT: "https://www.iomat.mt.gov.br/", MS: "https://www.spdo.ms.gov.br/diariodoe",
  MG: "https://www.jornalminasgerais.mg.gov.br/", PA: "https://www.ioepa.com.br/", PB: "https://auniao.pb.gov.br/",
  PR: "https://www.documentos.dioe.pr.gov.br/", PE: "https://diariooficial.cepe.com.br/", PI: "https://www.diario.pi.gov.br/",
  RJ: "https://www.ioerj.com.br/", RN: "http://diariooficial.rn.gov.br/", RS: "https://www.diariooficial.rs.gov.br/",
  RO: "https://diof.ro.gov.br/", RR: "https://www.imprensaoficial.rr.gov.br/", SC: "https://doe.sea.sc.gov.br/",
  SP: "https://doe.sp.gov.br/", SE: "https://www.segrase.se.gov.br/", TO: "https://diariooficial.to.gov.br/",
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pegar(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(25000) });
    return { status: r.status, final: r.url, texto: r.ok ? (await r.text()).slice(0, 400000) : "" };
  } catch (e) {
    return { status: 0, erro: String(e?.cause?.code ?? e?.name ?? e) };
  }
}

const out = {};
for (const [uf, url] of Object.entries(DIARIOS)) {
  const home = await pegar(url);
  const origem = home.final ? new URL(home.final).origin : new URL(url).origin;
  const rob = await pegar(origem + "/robots.txt");
  const regras = [];
  let aplica = false;
  for (const linha of (rob.status === 200 ? rob.texto : "").split("\n")) {
    const [k, ...v] = linha.split("#")[0].split(":");
    const val = v.join(":").trim();
    if (/^user-agent$/i.test(k?.trim() ?? "")) aplica = val === "*";
    else if (aplica && /^disallow$/i.test(k?.trim() ?? "") && val) regras.push(val);
  }
  const t = (home.texto ?? "").toLowerCase();
  out[uf] = {
    url, final: home.final ?? null, status: home.status, erro: home.erro ?? null,
    robots: rob.status === 200 ? (regras.includes("/") ? "PROIBE TUDO" : regras.slice(0, 12)) : `sem robots (${rob.status})`,
    tem_busca: /pesquis|busca|search|buscar/.test(t),
    fala_pdf: /\.pdf|pdf/.test(t),
    api_ou_json: /\/api\/|application\/json|dados abertos|swagger/.test(t),
    titulo: (home.texto ?? "").match(/<title[^>]*>([^<]*)/i)?.[1]?.trim()?.slice(0, 100) ?? null,
  };
  console.log(uf, out[uf].status, out[uf].robots, out[uf].tem_busca, out[uf].titulo);
  await sleep(800);
}
await writeFile(new URL("../status-diarios.json", import.meta.url), JSON.stringify({ testado_em: new Date().toISOString(), diarios: out }, null, 1) + "\n");
