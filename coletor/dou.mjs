// Coletor de concursos do Diário Oficial da União (Seção 3).
//
// Roda no GitHub Actions 2 vezes ao dia. Usa somente a busca pública da
// Imprensa Nacional (in.gov.br), com poucas requisições e um intervalo entre
// elas. Grava o resultado em concursos.json, que o app Lumen Plan lê.
//
// Uso: node coletor/dou.mjs  (Node 20+, sem dependências)

import { readFile, writeFile } from "node:fs/promises";

const ARQUIVO = new URL("../concursos.json", import.meta.url);
const UA = "LumenPlanRadar/1.0 (coletor de editais; +https://github.com/WSkywalker/lumen-radar-dados)";
// Uma frase por busca (a busca do DOU não combina frases entre aspas).
const BUSCAS = [
  '"concurso público para provimento"',
  '"abertura de inscrições"',
  '"torna pública a abertura"',
  '"realização de concurso público"', // contratos de banca = concurso previsto
  '"autorizar a realização de concurso público"', // portarias de autorização
  '"autoriza a realização de concurso público"',
];
const PERIODOS = ["dia", "semana"];
const MUNICIPIOS_URL = "https://study-zen-planner-53.lovable.app/municipios.json";
const MAX_NOVOS = 60; // páginas de edital lidas por execução
const PAUSA_MS = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hojeISO = () => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ */
/* acesso                                                              */
/* ------------------------------------------------------------------ */

async function baixar(url) {
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
      if (r.ok) return await r.text();
      if (r.status === 404) return null;
    } catch {
      /* tenta de novo */
    }
    await sleep(3000 * tentativa);
  }
  return null;
}

/** Busca na Seção 3 (do dia ou da semana) e devolve o JSON embutido na página. */
async function buscar(termo, periodo) {
  const u = new URL("https://www.in.gov.br/consulta/-/buscar/dou");
  u.searchParams.set("q", termo);
  u.searchParams.set("s", "do3");
  u.searchParams.set("exactDate", periodo);
  u.searchParams.set("sortType", "0");
  u.searchParams.set("delta", "50");
  const html = await baixar(u.toString());
  if (!html) return [];
  const m = html.match(/<script[^>]*id="[^"]*BuscaDouPortlet_params"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return [];
  try {
    return JSON.parse(m[1]).jsonArray ?? [];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* texto                                                               */
/* ------------------------------------------------------------------ */

const ENT = { nbsp: " ", amp: "&", quot: '"', lt: "<", gt: ">", ordm: "º", ordf: "ª" };
function textoLimpo(h) {
  return String(h ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}
const norm = (t) =>
  String(t ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** Texto principal de uma publicação do DOU. */
async function lerPublicacao(slug) {
  const html = await baixar(`https://www.in.gov.br/web/dou/-/${slug}`);
  if (!html) return null;
  const m =
    html.match(/<div[^>]*class="[^"]*texto-dou[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/) ??
    html.match(/<div[^>]*class="[^"]*texto-dou[^"]*"[^>]*>([\s\S]*)/);
  return textoLimpo(m ? m[1] : html).slice(0, 150000);
}

/* ------------------------------------------------------------------ */
/* extração por regras                                                 */
/* ------------------------------------------------------------------ */

const MESES = {
  janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7,
  agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12,
};
const iso = (d, m, y) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Todas as datas de um trecho, na ordem em que aparecem. */
function datas(trecho) {
  const t = norm(trecho);
  const out = [];
  const re = /(\d{1,2})\/(\d{1,2})\/(\d{4})|(\d{1,2})(?:º|o)? de (janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)(?: de (\d{4}))?/g;
  let m;
  while ((m = re.exec(t))) {
    if (m[1]) out.push({ pos: m.index, data: iso(+m[1], +m[2], +m[3]), ano: true });
    else out.push({ pos: m.index, data: iso(+m[4], MESES[m[5]], m[6] ? +m[6] : 0), ano: !!m[6] });
  }
  // completa o ano que faltar com o da data seguinte (ex.: "de 3 de março a 2 de abril de 2027")
  for (let i = out.length - 1; i >= 0; i--) {
    if (!out[i].ano) {
      const prox = out.slice(i + 1).find((x) => x.ano);
      const y = prox ? prox.data.slice(0, 4) : String(new Date().getFullYear());
      out[i].data = y + out[i].data.slice(4);
      out[i].ano = true;
    }
  }
  return out.filter((x) => !/^0|-00-/.test(x.data));
}

function periodoInscricoes(texto) {
  const t = norm(texto);
  const re = /inscri[cç](?:o|a)es?[^.]{0,220}?(?:periodo|entre|de|a partir)[^.]{0,200}/g;
  let m;
  while ((m = re.exec(t))) {
    const ds = datas(m[0]);
    if (ds.length >= 2 && ds[1].data >= ds[0].data) return [ds[0].data, ds[1].data];
  }
  return [null, null];
}

function dataProva(texto) {
  const t = norm(texto);
  const re = /(prova|provas) (objetiva|objetivas|escrita|escritas)?[^.]{0,160}/g;
  let m;
  while ((m = re.exec(t))) {
    if (!/(sera|serao|realizad|aplicad|data provavel|previst)/.test(m[0])) continue;
    const d = datas(m[0])[0];
    if (d) return d.data;
  }
  return null;
}

function vagas(texto) {
  const t = norm(texto);
  const nums = [...t.matchAll(/(\d{1,3}(?:\.\d{3})*|\d+)\s*(?:\([a-z\s-]+\)\s*)?vagas?\b/g)]
    .map((m) => Number(m[1].replace(/\./g, "")))
    .filter((n) => n > 0 && n < 100000);
  return nums.length ? Math.max(...nums) : null;
}

const BANCAS = [
  ["Cebraspe", /cebraspe|cespe/], ["FGV", /fundacao getulio vargas|\bfgv\b/], ["FCC", /fundacao carlos chagas|\bfcc\b/],
  ["Vunesp", /vunesp/], ["Cesgranrio", /cesgranrio/], ["IBFC", /\bibfc\b/], ["Idecan", /idecan/],
  ["Quadrix", /quadrix/], ["Consulplan", /consulplan/], ["Instituto AOCP", /\baocp\b/], ["Fundatec", /fundatec/],
  ["Selecon", /selecon/], ["IADES", /\biades\b/], ["Cesgranrio", /cesgranrio/], ["Instituto Verbena", /verbena/],
  ["Comperve", /comperve/], ["Fundep", /fundep/], ["IBADE", /\bibade\b/], ["Avança SP", /avanca sp/],
];
function banca(texto) {
  const t = norm(texto);
  return BANCAS.find(([, re]) => re.test(t))?.[0] ?? null;
}

function cargo(texto) {
  const t = String(texto).replace(/\s+/g, " ");
  const m =
    t.match(/provimento d[eoa]s? (?:\d+ \([^)]*\) )?(?:vagas? )?(?:para |no |nos |de )?cargos? (?:efetivos? )?d[eoa]s? ([^.,;:]{3,90})/i) ??
    t.match(/para o cargo d[eoa] ([^.,;:]{3,90})/i) ??
    t.match(/carreira d[eoa] ([^.,;:]{3,90})/i);
  if (!m) return "Diversos cargos";
  return m[1]
    .replace(/\s+(processo|edital)\b.*$/i, "")
    .replace(/\s+(do|da|no|na)\s+quadro.*$/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

const UF_NOMES = {
  AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
  ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul",
  MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí",
  RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima",
  SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins",
};
function uf(texto) {
  const t = norm(texto);
  const nomes = Object.entries(UF_NOMES).sort((a, b) => b[1].length - a[1].length);
  for (const [sigla, nome] of nomes) {
    const k = norm(nome);
    if (new RegExp(`\\b(do|da|de|no|na|em) ${k}\\b`).test(t)) return sigla;
  }
  const m = String(texto).match(/[-/(]\s?([A-Z]{2})\b/);
  return m && UF_NOMES[m[1]] ? m[1] : null;
}

const AREAS = [
  ["diplomatica", /diplomat|rio branco|itamaraty|relacoes exteriores|oficial de chancelaria/],
  ["militar", /exercito|marinha|aeronautica|comando da (marinha|aeronautica|exercito)|forcas armadas|ministerio da defesa/],
  ["policial", /policia|policial|penal|penitenciar|seguranca publica|perito criminal|agente de policia/],
  ["previdenciaria", /\binss\b|previdencia/],
  ["fiscal", /receita federal|fazenda|tribut|auditor|controladoria|tribunal de contas|banco central|\bcvm\b|tesouro/],
  ["tribunais", /tribunal|justica|ministerio publico|defensoria|advocacia-geral|procuradoria|\bagu\b/],
  ["outra", /universidade|instituto federal|professor|magisterio|docente|hospital universitario|ebserh|residencia/],
];
function area(texto) {
  const t = norm(texto);
  return AREAS.find(([, re]) => re.test(t))?.[0] ?? "administrativa";
}

let MUNIS = [];
async function carregarMunicipios() {
  try {
    const r = await fetch(MUNICIPIOS_URL, { headers: { "User-Agent": UA } });
    if (r.ok) MUNIS = await r.json(); // [nome, UF, lat, lon]
  } catch {
    MUNIS = [];
  }
}

/** Prefeituras publicam no DOU como "Prefeituras/Estado do Ceará/Prefeitura Municipal de X". */
function local(item) {
  const lista = (item.hierarchyList ?? String(item.hierarchyStr ?? "").split("/")).map(String);
  if (!/^prefeituras?$/i.test(lista[0] ?? "")) return null;
  const sigla = uf(lista[1] ?? "");
  const nome = String(lista[2] ?? "").replace(/^(prefeitura|camara)( municipal)? d[eoa]s? /i, "").trim();
  const m = MUNIS.find((x) => x[1] === sigla && norm(x[0]) === norm(nome));
  return { uf: sigla, cidade: m ? m[0] : nome || null, latitude: m ? m[2] : null, longitude: m ? m[3] : null };
}

/** Em portarias de autorização (publicadas pelo MGI), o órgão beneficiado vem no texto. */
function orgaoAutorizado(texto) {
  const t = String(texto).replace(/\s+/g, " ").slice(0, 3000);
  const m =
    t.match(/concurso p[úu]blico[^.]{0,160}?(?:no [âa]mbito d[oa]|para o quadro de pessoal d[oa]|do quadro de pessoal d[oa]) ([A-ZÁÂÃÉÊÍÓÔÕÚÇ][^,.;:()]{3,90})/) ??
    t.match(/concurso p[úu]blico (?:para|do|da) ([A-ZÁÂÃÉÊÍÓÔÕÚÇ][^,.;:()]{3,90})/);
  return m ? m[1].trim() : null;
}

/** Órgão: o nível da hierarquia mais útil (ex.: "Receita Federal", "Universidade Federal do Ceará"). */
function orgao(item) {
  const lista = (item.hierarchyList ?? String(item.hierarchyStr ?? "").split("/")).filter(Boolean);
  if (/^prefeituras?$/i.test(lista[0] ?? "") && lista[2]) return String(lista[2]).trim();
  const nivel = lista.length > 1 ? lista[1] : lista[0];
  return String(nivel ?? "Órgão federal").trim();
}

const ABERTURA = /(torna (publica|publico)[^.]{0,80}abertura|abertura d[ae]s? inscric|abertura de concurso|estarao abertas as inscricoes|ficam abertas as inscricoes)/;
const DESCARTA = /(resultado|homologa|prorroga|retifica|convoca|nomea|licitac|pregao|processo seletivo simplificado|professor substituto|professor visitante|mestrado|doutorado|residencia|monitoria|estagio|bolsista)/;

/* ------------------------------------------------------------------ */
/* execução                                                            */
/* ------------------------------------------------------------------ */

/**
 * Situações usadas pelo app:
 * previsto · autorizado · banca_contratada · edital_publicado ("Aberto") ·
 * aberto (inscrições abertas) · andamento (inscrições encerradas) · suspenso · encerrado
 */
function situacao(ini, fim, prova) {
  const h = hojeISO();
  if (prova && prova < h) return "encerrado";
  if (ini && h < ini) return "edital_publicado";
  if (fim && h > fim) return "andamento";
  if (ini || fim) return "aberto";
  return "edital_publicado";
}
const FIXAS = new Set(["previsto", "autorizado", "banca_contratada", "suspenso"]);

async function main() {
  let base = { itens: [] };
  try {
    base = JSON.parse(await readFile(ARQUIVO, "utf8"));
  } catch {
    /* primeira execução */
  }
  const porId = new Map(base.itens.map((i) => [i.id, i]));
  // itens de outras fontes (ex.: PNCP) passam direto; só os do DOU são revisados aqui

  // 1) busca
  const candidatos = new Map();
  await carregarMunicipios();
  for (const periodo of PERIODOS) {
    for (const termo of BUSCAS) {
      for (const it of await buscar(termo, periodo)) {
        const tipo = norm(it.artType);
        const resumo = norm(`${it.title} ${textoLimpo(it.content)}`);
        if (!/concurso publico/.test(resumo)) continue;
        const contrato = /extrato de contrato|extrato de dispensa|extrato de inexigibilidade/.test(tipo) && /(realizacao|organizacao|execucao) de concurso publico/.test(resumo);
        const edital = /edital/.test(tipo) && !/resultado|homolog|retifica|convoca/.test(tipo) && !DESCARTA.test(resumo);
        const autorizacao = /portaria/.test(tipo) && /autoriza(r)? a realizacao de concurso publico/.test(resumo);
        if (contrato) it._contrato = true;
        if (autorizacao) it._autorizacao = true;
        if (contrato || edital || autorizacao) candidatos.set(String(it.classPK), it);
      }
      await sleep(PAUSA_MS);
    }
  }
  console.log(`candidatos na busca: ${candidatos.size}`);

  // 2) lê os editais novos
  let lidos = 0, novos = 0;
  for (const [pk, it] of candidatos) {
    const id = `dou:${pk}`;
    if (porId.has(id)) {
      porId.get(id).visto_em = new Date().toISOString();
      continue;
    }
    if (lidos >= MAX_NOVOS) break;
    lidos++;
    await sleep(PAUSA_MS);
    const texto = await lerPublicacao(it.urlTitle);
    if (!texto) continue;
    const inicio = norm(texto.slice(0, 4000));
    const contrato = !!it._contrato;
    const autorizacao = !!it._autorizacao;
    const suspensao = false; // suspensões ficam para o cadastro manual (evita duplicar concursos)
    if (!contrato && !autorizacao && !suspensao && (!ABERTURA.test(inicio) || DESCARTA.test(norm(texto.slice(0, 600))))) continue;
    if (autorizacao && !/autoriza(r)? a realizacao de concurso publico/.test(inicio)) continue;
    if (suspensao && !/suspen/.test(inicio)) continue;
    const especial = contrato || autorizacao || suspensao;

    const [ini, fim] = especial ? [null, null] : periodoInscricoes(texto);
    const prova = especial ? null : dataProva(texto);
    const contexto = `${it.hierarchyStr} ${texto.slice(0, 3000)}`;
    const [d, m, y] = String(it.pubDate).split("/");
    const lugar = local(it);
    porId.set(id, {
      id,
      fonte_chave: id,
      origem: "robo",
      orgao: autorizacao ? orgaoAutorizado(texto) ?? orgao(it) : orgao(it),
      cargo: contrato ? "Concurso em preparação (banca contratada)" : cargo(texto),
      area: area(contexto),
      abrangencia: lugar?.cidade ? "municipal" : "federal",
      uf: lugar?.uf ?? uf(`${it.hierarchyStr} ${texto.slice(0, 1500)}`),
      cidade: lugar?.cidade ?? null,
      latitude: lugar?.latitude ?? null,
      longitude: lugar?.longitude ?? null,
      situacao: contrato ? "banca_contratada" : autorizacao ? "autorizado" : suspensao ? "suspenso" : situacao(ini, fim, prova),
      vagas: vagas(texto.slice(0, 20000)),
      banca: banca(texto),
      inscricoes_inicio: ini,
      inscricoes_fim: fim,
      prova_data: prova,
      edital_url: `https://www.in.gov.br/web/dou/-/${it.urlTitle}`,
      fonte_url: `https://www.in.gov.br/web/dou/-/${it.urlTitle}`,
      observacoes: `${String(it.title ?? "").trim()} — DOU de ${it.pubDate}, Seção 3, pág. ${it.numberPage ?? "?"}.`,
      publicado_em: y && m && d ? iso(+d, +m, +y) : null,
      verificado_em: new Date().toISOString(),
      visto_em: new Date().toISOString(),
    });
    novos++;
  }

  // 3) atualiza situação e remove o que já passou
  const h = hojeISO();
  const limite = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const itens = [...porId.values()]
    .map((i) => ({
      ...i,
      situacao: /banca contratada/.test(i.cargo ?? "") ? "banca_contratada" : !i.id.startsWith("dou:") || FIXAS.has(i.situacao) ? i.situacao : situacao(i.inscricoes_inicio, i.inscricoes_fim, i.prova_data),
    }))
    .filter((i) => !i.id.startsWith("dou:") || !(i.prova_data && i.prova_data < limite))
    .filter((i) => !i.id.startsWith("dou:") || !(!i.prova_data && i.publicado_em && i.publicado_em < new Date(Date.now() - 240 * 86_400_000).toISOString().slice(0, 10)))
    .sort((a, b) => String(b.publicado_em).localeCompare(String(a.publicado_em)));

  const saida = {
    fonte: "Fontes oficiais: Diário Oficial da União (in.gov.br, Seção 3) e PNCP (pncp.gov.br)",
    aviso: "Resumo automático de publicações oficiais. Confira sempre o edital no link.",
    gerado_em: new Date().toISOString(),
    total: itens.length,
    itens,
  };
  const antes = JSON.stringify({ ...base, gerado_em: null });
  const depois = JSON.stringify({ ...saida, gerado_em: null });
  // grava sempre que houver mudança (e ao menos 1x por dia, para registrar a verificação)
  if (antes !== depois || !base.gerado_em || base.gerado_em.slice(0, 10) !== h) {
    await writeFile(ARQUIVO, JSON.stringify(saida, null, 1) + "\n");
  }
  console.log(`editais lidos: ${lidos}; novos: ${novos}; total no arquivo: ${itens.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
