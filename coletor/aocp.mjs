// Coletor do Instituto AOCP (banca organizadora).
//
// Usa a mesma lista pública que o site da banca mostra aos candidatos
// (institutoaocp.org.br, sem robots.txt restritivo). Só entram CONCURSOS
// PÚBLICOS — processos seletivos (simplificados ou não) ficam de fora.
//
// Uso: node coletor/aocp.mjs  (Node 20+, sem dependências). Lê e atualiza concursos.json.

import { readFile, writeFile } from "node:fs/promises";

const ARQUIVO = new URL("../concursos.json", import.meta.url);
const UA = "LumenPlanRadar/1.0 (+https://github.com/WSkywalker/lumen-radar-dados)";
const MUNICIPIOS_URL = "https://study-zen-planner-53.lovable.app/municipios.json";
const LISTA = "https://www.institutoaocp.org.br/api/concursos?status=";
const DETALHE = "https://link.institutoaocp.org.br/api/concursos/";
const PAGINA = "https://www.institutoaocp.org.br/concursos/";
// status da banca -> situação no app
const STATUS = { NEW: "edital_publicado", SUBSCRIBE: "aberto", IN_PROGRESS: "andamento" };
const PAUSA_MS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
const hoje = () => new Date().toISOString().slice(0, 10);

async function json(url) {
  for (let t = 1; t <= 3; t++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {
      /* tenta de novo */
    }
    await sleep(2000 * t);
  }
  return null;
}

/** "23/11/2026 14:00:00" ou "2026-11-23 14:00:00" -> "2026-11-23" */
function data(v) {
  const s = String(v ?? "");
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/* ------------------------------------------------------------------ */
/* filtro: só concurso público                                         */
/* ------------------------------------------------------------------ */

function ehConcursoPublico(item) {
  const tipo = norm(item.tipoProcesso);
  const texto = norm(`${item.nome} ${item.chamada}`);
  if (/processo seletivo|selecao|residencia|vestibular|estagi/.test(tipo)) return false;
  if (/concurso/.test(tipo)) return !/processo seletivo simplificado/.test(texto);
  // tipo em branco: decide pelo texto
  return /concurso publico/.test(texto) && !/processo seletivo/.test(texto);
}

/* ------------------------------------------------------------------ */
/* local, órgão e área                                                 */
/* ------------------------------------------------------------------ */

const UF_NOMES = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
  ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul",
  MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí",
  RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima",
  SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};
function uf(texto) {
  const t = norm(texto);
  for (const [sigla, nome] of Object.entries(UF_NOMES).sort((a, b) => b[1].length - a[1].length)) {
    if (new RegExp(`\\b(do|da|de) (estado d[eoa] )?${norm(nome)}\\b`).test(t)) return sigla;
  }
  // siglas no nome: "PMPE", "CBMERJ", "TJ-SP", "- BA"
  const m = String(texto).match(/\b(?:PM|PC|CBM|CBMER|TJ|MP|DPE|SEFAZ|SEAP|PCI)[- ]?([A-Z]{2})\b/) ?? String(texto).match(/[-–]\s*([A-Z]{2})\s*$/);
  if (m && UF_NOMES[m[1]]) return m[1];
  if (/\bCBMERJ\b/.test(texto)) return "RJ";
  return null;
}

let MUNIS = [];
function cidade(texto, sigla) {
  const t = " " + norm(texto).replace(/[^a-z0-9 ]/g, " ") + " ";
  let melhor = null;
  for (const m of MUNIS) {
    if (sigla && m[1] !== sigla) continue;
    const k = norm(m[0]);
    if (k.length >= 4 && t.includes(` ${k} `) && (!melhor || k.length > norm(melhor[0]).length)) melhor = m;
  }
  return melhor;
}

/** "PMPE - POLÍCIA MILITAR DE PERNAMBUCO" -> "Polícia Militar de Pernambuco (PMPE)" */
function orgao(nome) {
  const [sigla, ...resto] = String(nome).split(/\s+[-–]\s+/);
  const extenso = resto.join(" - ").replace(/\s+[-–]\s+[A-Z]{2}\s*$/, "").trim();
  const titulo = (s) =>
    s
      .toLowerCase()
      .replace(/(^|[\s(/-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())
      .replace(/\b(De|Do|Da|Dos|Das|E|Em)\b/g, (w) => w.toLowerCase())
      .replace(/\s+-\s+([a-z]{2})$/i, (_, u) => ` - ${u.toUpperCase()}`);
  if (!extenso) return titulo(sigla);
  return /^[A-Z0-9]{2,12}$/.test(sigla.trim()) ? `${titulo(extenso)} (${sigla.trim()})` : titulo(String(nome));
}

const AREAS = [
  ["militar", /bombeiro|exercito|marinha|aeronautica/],
  ["policial", /policia|policial|penal|penitenciar|seguranca publica|guarda (civil )?municipal|perito|detran|defesa social/],
  ["previdenciaria", /previdencia|\binss\b|\bipsm\b|\bipm\b/],
  ["fiscal", /fazenda|tribut|fiscal|auditor|receita|controladoria|tribunal de contas/],
  ["tribunais", /tribunal|justica|ministerio publico|defensoria|procuradoria/],
  ["diplomatica", /relacoes exteriores|itamaraty|diplomat/],
];
const area = (t) => AREAS.find(([, re]) => re.test(norm(t)))?.[0] ?? "administrativa";

/* ------------------------------------------------------------------ */
/* execução                                                            */
/* ------------------------------------------------------------------ */

async function main() {
  const base = JSON.parse(await readFile(ARQUIVO, "utf8"));
  const porId = new Map(base.itens.map((i) => [i.id, i]));
  try {
    const r = await fetch(MUNICIPIOS_URL, { headers: { "User-Agent": UA } });
    if (r.ok) MUNIS = await r.json();
  } catch {
    MUNIS = [];
  }

  const vistos = new Set();
  let lidos = 0, aceitos = 0;
  for (const [status, situacaoBanca] of Object.entries(STATUS)) {
    const lista = (await json(LISTA + status)) ?? [];
    await sleep(PAUSA_MS);
    for (const it of Array.isArray(lista) ? lista : []) {
      lidos++;
      if (!ehConcursoPublico(it)) continue;
      aceitos++;
      const id = `aocp:${it.id}`;
      vistos.add(id);

      const det = (await json(DETALHE + it.id))?.[0] ?? null;
      await sleep(PAUSA_MS);
      const ini = data(det?.dataInicioInscricao ?? it.dataInicioInscricao);
      const fim = data(det?.dataFinalInscricao ?? it.dataInscricao);
      const prova = data(it.dataProva);
      const pubs = Array.isArray(det?.publicacoes) ? det.publicacoes : [];
      const abertura =
        pubs.find((p) => /edital de abertura/i.test(p.nome) && !/retifica/i.test(p.nome)) ??
        pubs.find((p) => /edital de abertura/i.test(p.nome));

      let situacao = situacaoBanca;
      const h = hoje();
      if (prova && prova < h) situacao = "encerrado";
      else if (ini && h < ini) situacao = "edital_publicado";
      else if (fim && h > fim) situacao = "andamento";
      else if (ini || fim) situacao = "aberto";
      if (/suspens/i.test(it.chamada ?? "")) situacao = "suspenso";

      const texto = `${it.nome} ${it.chamada ?? ""} ${det?.chamada ?? ""}`;
      const sigla = uf(texto);
      const municipal = /prefeitura|camara municipal|municipio|servidor municipal|\bsemae\b|\bipsm\b/i.test(norm(it.nome));
      const mun = municipal ? cidade(`${it.nome} ${det?.chamada ?? ""}`, sigla) : null;
      const anterior = porId.get(id);
      porId.set(id, {
        ...(anterior ?? {}),
        id,
        fonte_chave: id,
        origem: "robo",
        orgao: orgao(it.nome),
        cargo: anterior?.cargo ?? "Diversos cargos",
        area: area(texto),
        abrangencia: mun ? "municipal" : sigla ? "estadual" : "federal",
        uf: mun?.[1] ?? sigla,
        cidade: mun?.[0] ?? null,
        latitude: mun?.[2] ?? null,
        longitude: mun?.[3] ?? null,
        situacao,
        vagas: typeof it.vagas === "number" ? it.vagas : (anterior?.vagas ?? null),
        banca: "Instituto AOCP",
        inscricoes_inicio: ini,
        inscricoes_fim: fim,
        prova_data: prova ?? anterior?.prova_data ?? null,
        edital_url: abertura?.url ?? anterior?.edital_url ?? `${PAGINA}${it.id}`,
        fonte_url: `${PAGINA}${it.id}`,
        observacoes: `${String(it.chamada ?? "").replace(/\s+/g, " ").trim().slice(0, 280)} — fonte: site do Instituto AOCP.`,
        publicado_em: anterior?.publicado_em ?? h,
        verificado_em: new Date().toISOString(),
        visto_em: new Date().toISOString(),
      });
    }
  }

  // concursos da AOCP que saíram das listas ativas: encerrados (somem do Radar)
  for (const i of porId.values()) {
    if (i.id.startsWith("aocp:") && !vistos.has(i.id) && lidos > 0) i.situacao = "encerrado";
  }
  const limite = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const itens = [...porId.values()].filter(
    (i) => !(i.id.startsWith("aocp:") && i.situacao === "encerrado" && String(i.visto_em) < limite),
  );

  await writeFile(
    ARQUIVO,
    JSON.stringify({ ...base, gerado_em: new Date().toISOString(), total: itens.length, itens }, null, 1) + "\n",
  );
  console.log(`AOCP: lidos ${lidos}; concursos públicos ${aceitos}; total no arquivo ${itens.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
