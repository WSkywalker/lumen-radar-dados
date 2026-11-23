// Lê o edital de cada concurso para completar vagas, cargos e data da prova.
//
// 1) Regras: procura "750 (setecentas e cinquenta) vagas", "100 (cem) vagas para o cargo de…",
//    linhas "Total de vagas de <cargo> 12" e a data das provas.
// 2) IA (opcional): só quando as regras não acham os cargos ou as vagas e existe o segredo
//    GEMINI_API_KEY no GitHub. Sem a chave, ou se a cota grátis acabar, fica só nas regras.
//
// Cada edital é lido uma vez: o resultado fica em editais-lidos.json (por endereço do edital)
// e é reaplicado a cada execução, mesmo que outro coletor reescreva o concurso.
//
// Uso: node coletor/editais.mjs            (lê editais novos e aplica)
//      node coletor/editais.mjs --aplicar  (só aplica o que já foi lido; sem internet)
// Precisa de "pdfjs-dist" instalado para os editais em PDF.

import { readFile, writeFile } from "node:fs/promises";
import { MESES, dataProva, iso, norm, textoLimpo } from "./regras.mjs";

const ARQUIVO = new URL("../concursos.json", import.meta.url);
const CACHE = new URL("../editais-lidos.json", import.meta.url);
const UA = "LumenPlanRadar/1.0 (+https://github.com/WSkywalker/lumen-radar-dados)";
const SO_APLICAR = process.argv.includes("--aplicar");
const MAX_LEITURAS = Number(process.env.EDITAIS_MAX ?? 30);
const MAX_IA = Number(process.env.EDITAIS_MAX_IA ?? 8);
const CHAVE = (process.env.GEMINI_API_KEY ?? "").trim();
const MAX_BYTES = 25 * 1024 * 1024;
const DIA = 86_400_000;

const hoje = () => new Date().toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* baixar e extrair texto                                               */
/* ------------------------------------------------------------------ */

async function baixar(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60_000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal, redirect: "follow" });
    if (!r.ok) return null;
    const tipo = r.headers.get("content-type") ?? "";
    const buf = new Uint8Array(await r.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) return null;
    const pdf = /pdf/i.test(tipo) || (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);
    return { pdf, buf };
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

let pdfjs = null;
async function textoDoPdf(bytes) {
  pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;
  const partes = [];
  for (let p = 1; p <= Math.min(doc.numPages, 60); p++) {
    const page = await doc.getPage(p);
    const c = await page.getTextContent();
    let linha = "";
    let ultimoY = null;
    for (const it of c.items) {
      const y = it.transform?.[5];
      if (ultimoY !== null && Math.abs(y - ultimoY) > 2) {
        partes.push(linha);
        linha = "";
      }
      linha += (linha && !linha.endsWith(" ") ? " " : "") + it.str;
      ultimoY = y;
    }
    partes.push(linha);
  }
  return partes.join("\n");
}

/* ------------------------------------------------------------------ */
/* regras                                                               */
/* ------------------------------------------------------------------ */

const RUIM = /ampla|reservad|negro|pcd|deficien|cota|afrodescend|indigen|quilombol|imediat|cadastro|total geral|geral de vagas/i;

function limpaNome(s) {
  return String(s)
    .replace(/\s+/g, " ")
    // ligaduras quebradas na extração do PDF: "O fi ciais" -> "Oficiais"
    .replace(/([A-Za-zÀ-ú]+) (fi|fl|ff) ([a-zà-ú]+)/g, "$1$2$3")
    .replace(/^(o|a|os|as)\s+/i, "")
    // "Oficiais Combatente do Corpo de Bombeiros…" -> "Oficiais Combatente"
    .replace(
      /\s+d[oa]s?\s+(?:Pol[ií]cia|Corpo de Bombeiros|Secretaria|Prefeitura|Tribunal|Estado|Munic[ií]pio|C[âa]mara|Minist[ée]rio|Universidade|Instituto|Assembleia|Defensoria|Guarda|Quadro)\b.*$/i,
      "",
    )
    .replace(/[\s,;:–-]+$/, "")
    .trim()
    .slice(0, 80);
}

function juntaCargos(lista) {
  const porNome = new Map();
  for (const c of lista) {
    const nome = limpaNome(c.nome);
    if (nome.length < 3 || RUIM.test(nome)) continue;
    const k = norm(nome);
    const atual = porNome.get(k);
    if (atual) atual.vagas = atual.vagas === null || c.vagas === null ? atual.vagas ?? c.vagas : atual.vagas + c.vagas;
    else porNome.set(k, { nome, vagas: c.vagas });
  }
  return [...porNome.values()].slice(0, 40);
}

/** Cargos e vagas pelo texto do edital. */
export function regrasEdital(texto) {
  const t = texto.replace(/\s+/g, " ");
  const inicio = t.slice(0, 80_000);
  const cargos = [];

  // "100 (cem) vagas para o cargo de Delegado de Polícia Civil, 150 (…) vagas para o cargo de …"
  // e "40 (quarenta) para o quadro de Oficiais…", "1.250 (…) vagas na Qualificação Policial Militar Geral"
  const prosa = /(\d{1,3}(?:\.\d{3})*|\d+)\s*\(\s*[a-zà-ú\s-]{2,80}\)\s*(?:vagas?\s+)?(?:para|ao|no|na|destinadas ao)\s+(?:o\s+|a\s+)?(?:cargo|quadro|especialidade|fun[çc][ãa]o|qualifica[çc][ãa]o|emprego)\b(?:\s+d[eoa]s?)?\s*(.{3,90}?)(?=\s*(?:,|;|\.|\(|\s+e\s+(?:de\s+)?\d|\s+o qual|\s+que\s|\s+sendo\s|\s+cuja\s|\s+na graduação|\s+no posto|$))/gi;
  const corrido = inicio.replace(/([a-zà-ú]) (fi|fl|ff) ([a-zà-ú])/gi, "$1$2$3");
  let primeiro = -1;
  for (const m of corrido.matchAll(prosa)) {
    // só o primeiro parágrafo que distribui as vagas (o edital costuma repetir isso mais adiante)
    if (primeiro < 0) primeiro = m.index;
    else if (m.index > primeiro + 2000) break;
    // "70 vagas no Quadro de Oficiais…, sendo 40 para…": é o total, não um cargo
    const resto = corrido.slice(m.index + m[0].length, m.index + m[0].length + 120);
    if (/\bsendo\b/i.test(resto.split(/\d[\d.]*\s*\(/)[0])) continue;
    // mesmo número grande de novo com outro nome: o edital repetindo o total ("…provimento de 510 vagas no cargo de Praça")
    const n = Number(m[1].replace(/\./g, ""));
    if (n >= 20 && cargos.some((c) => c.vagas === n)) continue;
    // "na Qualificação Policial Militar Geral": a palavra-chave faz parte do nome
    const kw = m[0].match(/\b(qualifica[çc][ãa]o)\b/i)?.[1];
    cargos.push({ nome: kw ? `${kw} ${m[2]}` : m[2], vagas: n });
  }

  // quadro: "Total de vagas de Oficial Médico 12"
  if (!cargos.length) {
    const quadro = /total de vagas (?:de |do |da |para o cargo de |para )(.{3,70}?)\s*[:\-–]?\s*(\d{1,5})(?!\s*[,.]\d)(?=\s|$)/gi;
    for (const m of inicio.matchAll(quadro)) {
      if (RUIM.test(m[1])) continue;
      cargos.push({ nome: m[1], vagas: Number(m[2]) });
    }
  }

  const lista = juntaCargos(cargos);

  // total: "oferta de 750 (setecentas e cinquenta) vagas" no começo do edital
  let total = null;
  const tot = inicio
    .slice(0, 30_000)
    .match(/(?:total de|oferta de|provimento de|preenchimento de)\s+(\d{1,3}(?:\.\d{3})*|\d+)\s*\(\s*[a-zà-ú\s-]{2,80}\)\s*vagas/i);
  if (tot) total = Number(tot[1].replace(/\./g, ""));
  const soma = lista.reduce((a, c) => a + (c.vagas ?? 0), 0);
  if (soma > (total ?? 0)) total = soma; // ex.: "70 vagas de oficiais … e 1.250 vagas de soldado"
  if (total !== null && (total <= 0 || total > 100_000)) total = null;

  return { cargos: lista, vagas: total, prova: provaDoEdital(t) };
}

/** Data da prova: cronograma ("Aplicação das provas objetivas 06/12/2026") ou texto corrido. */
function provaDoEdital(t) {
  const n = norm(t);
  const crono = n.match(/aplicacao d[ao]s? provas?(?: objetivas?| escritas?)?[^0-9]{0,60}(\d{2})\/(\d{2})\/(\d{4})/);
  if (crono) return iso(Number(crono[1]), Number(crono[2]), Number(crono[3]));
  const extenso = n.match(
    new RegExp(
      `provas? (?:objetivas?|escritas?)[^.]{0,120}?(\\d{1,2}) de (${Object.keys(MESES).join("|")}) de (\\d{4})`,
    ),
  );
  if (extenso) return iso(Number(extenso[1]), MESES[extenso[2]], Number(extenso[3]));
  return dataProva(t.slice(0, 120_000));
}

/* ------------------------------------------------------------------ */
/* IA (Gemini, chave gratuita guardada como segredo do GitHub)          */
/* ------------------------------------------------------------------ */

const MODELOS = ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"];
let iaUsadas = 0;
let iaCotaAcabou = false;

/** Texto do PDF com fonte embaralhada (letras trocadas): não dá para ler por regras. */
export function ilegivel(texto) {
  const n = norm(texto.slice(0, 30_000));
  const palavras = (n.match(/\b(de|do|da|dos|das|para|concurso|edital|cargo|vagas|prova|inscric\w*)\b/g) ?? []).length;
  return palavras < Math.max(15, n.length / 400);
}

async function iaEdital(texto, pdfBytes) {
  if (!CHAVE || iaCotaAcabou || iaUsadas >= MAX_IA) return null;
  iaUsadas++;
  const prompt =
    "Você recebe o texto de um edital de concurso público brasileiro. Responda só com JSON. " +
    "Liste os cargos (nome curto do cargo/especialidade, sem código) com o total de vagas de cada um " +
    "(somando ampla concorrência e reservas; use null se o edital não disser), o total geral de vagas " +
    "(null se não houver) e a data da prova objetiva no formato AAAA-MM-DD (vazio se não houver). " +
    "Não invente nada que não esteja no edital." +
    (pdfBytes ? "" : "\n\nTEXTO DO EDITAL:\n" + texto.replace(/\s+/g, " ").slice(0, 60_000));
  const parts = pdfBytes
    ? [
        { inline_data: { mime_type: "application/pdf", data: Buffer.from(pdfBytes).toString("base64") } },
        { text: prompt },
      ]
    : [{ text: prompt }];
  const schema = {
    type: "OBJECT",
    properties: {
      cargos: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: { nome: { type: "STRING" }, vagas: { type: "INTEGER", nullable: true } },
          required: ["nome"],
        },
      },
      total_vagas: { type: "INTEGER", nullable: true },
      data_prova: { type: "STRING" },
    },
    required: ["cargos"],
  };
  for (const modelo of MODELOS) {
    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 90_000);
      try {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
          {
            method: "POST",
            signal: ctl.signal,
            headers: { "Content-Type": "application/json", "x-goog-api-key": CHAVE },
            body: JSON.stringify({
              contents: [{ role: "user", parts }],
              generationConfig: { responseMimeType: "application/json", responseSchema: schema },
            }),
          },
        );
        if (r.status === 429) {
          iaCotaAcabou = true; // cota grátis do dia acabou: segue só com regras
          return null;
        }
        if (r.status === 404 || r.status === 400) break; // modelo indisponível: tenta o próximo
        if (!r.ok) {
          await sleep(4000 * tentativa);
          continue;
        }
        const j = await r.json();
        const txt = j?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
        const o = JSON.parse(txt);
        const cargos = juntaCargos(
          (Array.isArray(o.cargos) ? o.cargos : []).map((c) => ({
            nome: String(c?.nome ?? ""),
            vagas: Number.isInteger(c?.vagas) && c.vagas >= 0 ? c.vagas : null,
          })),
        );
        const soma = cargos.reduce((a, c) => a + (c.vagas ?? 0), 0);
        let vagas = Number.isInteger(o.total_vagas) && o.total_vagas > 0 ? o.total_vagas : soma || null;
        if (vagas !== null && vagas > 100_000) vagas = null;
        const prova = /^\d{4}-\d{2}-\d{2}$/.test(String(o.data_prova ?? "")) ? o.data_prova : null;
        return { cargos, vagas, prova };
      } catch {
        await sleep(3000);
      } finally {
        clearTimeout(tm);
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* aplicar nos concursos                                                */
/* ------------------------------------------------------------------ */

const GENERICO = /^(diversos|v[aá]rios|cargos? a definir|a definir|n[aã]o informado|—|-)/i;

function aplicar(item, r) {
  if (!r || r.erro) return false;
  let mudou = false;
  if (r.cargos?.length) {
    if (JSON.stringify(item.cargos ?? null) !== JSON.stringify(r.cargos)) {
      item.cargos = r.cargos;
      mudou = true;
    }
    if (!item.cargo || GENERICO.test(item.cargo)) {
      const nomes = r.cargos.map((c) => c.nome);
      item.cargo =
        nomes.length <= 3 ? nomes.join(", ") : `${nomes.slice(0, 2).join(", ")} e mais ${nomes.length - 2} cargos`;
      mudou = true;
    }
  }
  if (r.vagas && !item.vagas) {
    item.vagas = r.vagas;
    mudou = true;
  }
  if (r.prova && !item.prova_data && r.prova >= hoje() && r.prova <= new Date(Date.now() + 730 * DIA).toISOString().slice(0, 10)) {
    item.prova_data = r.prova;
    mudou = true;
  }
  return mudou;
}

function precisa(item) {
  return !item.vagas || !item.cargos?.length || !item.prova_data || GENERICO.test(item.cargo ?? "");
}

async function main() {
  const base = JSON.parse(await readFile(ARQUIVO, "utf8"));
  let cache = {};
  try {
    cache = JSON.parse(await readFile(CACHE, "utf8"));
  } catch {
    cache = {};
  }

  let lidos = 0;
  let porIa = 0;
  let aplicados = 0;
  const fila = SO_APLICAR
    ? []
    : base.itens
        .filter((i) => i.edital_url && /^https?:\/\//.test(i.edital_url) && i.situacao !== "encerrado" && precisa(i))
        .filter((i) => {
          const c = cache[i.edital_url];
          if (!c) return true;
          // releitura: só se nada foi achado, no máx. 3 tentativas, uma por semana
          const vazio = !c.vagas && !c.cargos?.length;
          return vazio && (c.tentativas ?? 1) < 3 && Date.now() - new Date(c.em).getTime() > 7 * DIA;
        })
        .sort((a, b) => Number(!!a.vagas) - Number(!!b.vagas))
        .slice(0, MAX_LEITURAS);

  for (const item of fila) {
    const url = item.edital_url;
    const anterior = cache[url];
    const arq = await baixar(url);
    let r = { erro: "não baixou" };
    if (arq) {
      let texto = "";
      try {
        texto = arq.pdf ? await textoDoPdf(arq.buf) : textoLimpo(new TextDecoder("utf-8").decode(arq.buf));
      } catch {
        texto = "";
      }
      const legivel = texto.length > 300 && !ilegivel(texto);
      // PDF pequeno vai inteiro para a IA (lê tabelas e PDFs com fonte embaralhada)
      const pdfParaIa = arq.pdf && arq.buf.byteLength <= 15 * 1024 * 1024 ? arq.buf : null;
      if (legivel || pdfParaIa) {
        r = legivel ? { ...regrasEdital(texto), metodo: "regras" } : { cargos: [], vagas: null, prova: null, metodo: "regras" };
        if (!r.cargos.length || !r.vagas) {
          const ia = await iaEdital(texto, pdfParaIa);
          if (ia && (ia.cargos.length || ia.vagas)) {
            r = {
              cargos: ia.cargos.length ? ia.cargos : r.cargos,
              vagas: ia.vagas ?? r.vagas,
              prova: r.prova ?? ia.prova,
              metodo: "ia",
            };
            porIa++;
          }
        }
      } else r = { erro: texto.length > 300 ? "texto ilegível" : "sem texto (PDF escaneado?)" };
    }
    cache[url] = { ...r, em: new Date().toISOString(), tentativas: (anterior?.tentativas ?? 0) + 1 };
    lidos++;
    await sleep(800);
  }

  for (const item of base.itens) {
    const r = item.edital_url ? cache[item.edital_url] : null;
    if (r && aplicar(item, r)) {
      item.edital_lido = { em: r.em, metodo: r.metodo };
      aplicados++;
    }
  }

  // limpa leituras de editais que já saíram da lista
  const urls = new Set(base.itens.map((i) => i.edital_url).filter(Boolean));
  for (const u of Object.keys(cache)) if (!urls.has(u)) delete cache[u];

  await writeFile(ARQUIVO, JSON.stringify(base, null, 1) + "\n");
  await writeFile(CACHE, JSON.stringify(cache, null, 1) + "\n");
  console.log(
    `editais: ${lidos} lidos agora (${porIa} com IA${CHAVE ? "" : "; IA desligada: sem GEMINI_API_KEY"}${iaCotaAcabou ? "; cota da IA acabou" : ""}); ${aplicados} concursos completados`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
