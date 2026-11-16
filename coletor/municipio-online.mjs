// Coletor dos Diários Oficiais municipais do sistema "Município Online"
// (municipioonline.com.br), usado por 50 dos 75 municípios de Sergipe.
//
// Para cada município: abre a página pública do diário, pega as edições do
// dia (a mais recente), baixa o PDF e procura EDITAIS DE ABERTURA DE CONCURSO
// PÚBLICO. Processos seletivos, convocações, resultados, homologações e
// retificações ficam de fora.
//
// Uso: node coletor/municipio-online.mjs  (Node 20+, precisa de "pdfjs-dist" instalado)

import { readFile, writeFile } from "node:fs/promises";
import { area, banca, cargo, dataProva, norm, periodoInscricoes, vagas } from "./regras.mjs";

const ARQUIVO = new URL("../concursos.json", import.meta.url);
const UA = "LumenPlanRadar/1.0 (+https://github.com/WSkywalker/lumen-radar-dados)";
const BASE = "https://www.municipioonline.com.br";
const MUNICIPIOS_URL = "https://study-zen-planner-53.lovable.app/municipios.json";
const UF = "SE";
// municípios de Sergipe que usam o sistema (levantamento de 16/11/2026)
const CIDADES = [
  "aquidaba", "araua", "areiabranca", "barradoscoqueiros", "boquim", "campodobrito", "canhoba",
  "canindedesaofrancisco", "capela", "carmopolis", "cristinapolis", "cumbe", "divinapastora", "feiranova",
  "freipaulo", "ilhadasflores", "itabaiana", "itabaianinha", "itaporangadajuda", "japaratuba", "japoata",
  "lagarto", "laranjeiras", "macambira", "malhadadosbois", "maruim", "moitabonita", "muribeca",
  "nossasenhoradagloria", "nossasenhoradasdores", "nossasenhoradelourdes", "nossasenhoradosocorro",
  "pacatuba", "pedramole", "pedrinhas", "pirambu", "pocoverde", "propria", "riachaododantas",
  "rosariodocatete", "salgado", "santarosadelima", "simaodias", "siriri", "saodomingos", "saofrancisco",
  "telha", "tobiasbarreto", "tomardogeru", "umbauba",
];
const PAUSA_MS = 1200;
// dias para trás (1 = só a edição mais recente). Para recuperar o passado: MO_DIAS=15
const DIAS = Math.min(Number(process.env.MO_DIAS ?? 1), 31);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (n) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function baixar(url, binario = false, corpo = null) {
  for (let t = 1; t <= 3; t++) {
    try {
      const r = await fetch(url, {
        method: corpo ? "POST" : "GET",
        body: corpo ?? undefined,
        headers: { "User-Agent": UA, ...(corpo ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
        signal: AbortSignal.timeout(45000),
      });
      if (r.ok) return binario ? new Uint8Array(await r.arrayBuffer()) : await r.text();
      if (r.status === 404) return null;
    } catch {
      /* tenta de novo */
    }
    await sleep(2500 * t);
  }
  return null;
}

let pdfjs = null;
async function textoDoPdf(bytes) {
  pdfjs ??= await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: bytes, useSystemFonts: true, isEvalSupported: false }).promise;
  const partes = [];
  for (let p = 1; p <= Math.min(doc.numPages, 120); p++) {
    const page = await doc.getPage(p);
    const c = await page.getTextContent();
    let linha = "", ultimoY = null;
    for (const it of c.items) {
      const y = it.transform?.[5];
      if (ultimoY !== null && Math.abs(y - ultimoY) > 2) {
        partes.push(linha);
        linha = "";
      }
      linha += it.str;
      ultimoY = y;
    }
    partes.push(linha, "\f");
  }
  return partes.join("\n");
}

// abertura de concurso público (no título ou no começo do ato)
const SINAL = /(torna (publica|publico)[^.]{0,80}abertura|abertura d[ae]s? inscric|abertura do concurso|edital de abertura|estarao abertas as inscric|ficam abertas as inscric|torna publica a realizacao de concurso|realizacao de concurso publico para (o )?provimento)/;
const FORA = /(processo seletivo|selecao simplificada|convoca|resultado|homolog|classifica|retifica|rerratifica|prorroga|nomea|posse|gabarito|recurso|deferi|errata|cancelamento|anulacao|suspensao|estagi|residencia|credenciamento|chamamento)/;

/** Edições listadas na página (data escolhida + "<option value=CODIGO.pdf>1487/2026"). */
function edicoesDaPagina(html) {
  const sel = html.match(/name="ctl00\$body\$ddlEdicao"[\s\S]*?<\/select>/)?.[0] ?? "";
  const dataEd = html.match(/name="ctl00\$body\$txtDataEdicao"[^>]*value="(\d{2})\/(\d{2})\/(\d{4})"/);
  const data = dataEd ? `${dataEd[3]}-${dataEd[2]}-${dataEd[1]}` : new Date().toISOString().slice(0, 10);
  return [...sel.matchAll(/<option[^>]*value="([^"]+)\.pdf"[^>]*>([^<]*)</g)].slice(0, 3).map((x) => ({ codigo: x[1], numero: x[2].trim(), data }));
}

/** Campos ocultos do formulário ASP.NET (__VIEWSTATE etc.). */
function camposOcultos(html) {
  const p = new URLSearchParams();
  for (const m of html.matchAll(/<input[^>]*type="hidden"[^>]*>/g)) {
    const nome = m[0].match(/name="([^"]+)"/)?.[1];
    const valor = m[0].match(/value="([^"]*)"/)?.[1] ?? "";
    if (nome) p.set(nome, valor.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
  }
  return p;
}

/** Atos de abertura dentro do texto do diário: começam em "EDITAL" e falam de concurso público. */
function editais(texto) {
  const t = texto.replace(/[ \t]+/g, " ");
  const n = t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const achados = [];
  const re = /\n\s*edital\b/g;
  let m;
  while ((m = re.exec(n))) {
    const ini = m.index;
    const titulo = n.slice(ini, ini + 500).replace(/\s+/g, " ");
    if (!/concurso publico/.test(titulo) || !SINAL.test(n.slice(ini, ini + 2500).replace(/\s+/g, " "))) continue;
    if (FORA.test(titulo.slice(0, 260))) continue;
    // sumário da edição: linha curta com "...", ignora (o ato completo vem depois)
    if (/\.{5,}/.test(titulo.slice(0, 200))) continue;
    achados.push(t.slice(ini, ini + 15000).replace(/\s+/g, " ").trim());
  }
  // um mesmo edital pode aparecer em mais de um ponto: fica o primeiro
  const vistos = new Set();
  return achados.filter((a) => {
    const k = norm(a.slice(0, 120));
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

async function main() {
  const base = JSON.parse(await readFile(ARQUIVO, "utf8"));
  const porId = new Map(base.itens.map((i) => [i.id, i]));
  let MUNIS = [];
  try {
    MUNIS = (await (await fetch(MUNICIPIOS_URL, { headers: { "User-Agent": UA } })).json()).filter((m) => m[1] === UF);
  } catch {
    MUNIS = [];
  }

  const resumo = { cidades: 0, edicoes: 0, editais: 0, novos: 0, erros: 0 };
  for (const s of CIDADES) {
    const pagina = await baixar(`${BASE}/se/prefeitura/${s}/cidadao/diariooficial`);
    await sleep(PAUSA_MS);
    if (!pagina) {
      resumo.erros++;
      continue;
    }
    resumo.cidades++;
    const mun = MUNIS.find((m) => slug(m[0]) === s);
    const nomeCidade = mun?.[0] ?? s;
    const lote = edicoesDaPagina(pagina);
    // dias anteriores: escolhe a data no formulário da própria página
    for (let d = 1; d < DIAS; d++) {
      const dia = new Date(Date.now() - d * 86_400_000);
      const br = `${String(dia.getUTCDate()).padStart(2, "0")}/${String(dia.getUTCMonth() + 1).padStart(2, "0")}/${dia.getUTCFullYear()}`;
      const campos = camposOcultos(pagina);
      campos.set("__EVENTTARGET", "ctl00$body$txtDataEdicao");
      campos.set("__EVENTARGUMENT", "");
      campos.set("ctl00$body$rbPesquisa", "rbPesquisaData");
      campos.set("ctl00$body$txtDataEdicao", br);
      const outra = await baixar(`${BASE}/se/prefeitura/${s}/cidadao/diariooficial`, false, campos.toString());
      await sleep(PAUSA_MS);
      if (outra) for (const e of edicoesDaPagina(outra)) if (!lote.some((x) => x.codigo === e.codigo)) lote.push(e);
    }
    for (const ed of lote) {
      const dataIso = ed.data;
      const pdfUrl = `${BASE}/se/prefeitura/${s}/cidadao/diariooficial/diario?n=diario.pdf&l=${encodeURIComponent(ed.codigo)}`;
      const bytes = await baixar(pdfUrl, true);
      await sleep(PAUSA_MS);
      if (!bytes || bytes.length < 500) continue;
      resumo.edicoes++;
      let texto = "";
      try {
        texto = await textoDoPdf(bytes);
      } catch {
        resumo.erros++;
        continue;
      }
      for (const ato of editais(texto)) {
        resumo.editais++;
        const numEdital = (ato.match(/edital[^0-9]{0,30}(\d{1,4}\s*\/\s*\d{2,4})/i)?.[1] ?? ed.numero).replace(/\s+/g, "");
        const id = `mo:${s}-${numEdital.replace(/\//g, "-")}`;
        if (porId.has(id)) {
          porId.get(id).visto_em = new Date().toISOString();
          continue;
        }
        const [insIni, insFim] = periodoInscricoes(ato);
        const prova = dataProva(ato);
        const hoje = new Date().toISOString().slice(0, 10);
        let situacao = "edital_publicado";
        if (prova && prova < hoje) situacao = "encerrado";
        else if (insIni && hoje < insIni) situacao = "edital_publicado";
        else if (insFim && hoje > insFim) situacao = "andamento";
        else if (insIni || insFim) situacao = "aberto";
        const camara = /c[âa]mara municipal/i.test(ato.slice(0, 400));
        const orgao = `${camara ? "Câmara Municipal" : "Prefeitura"} de ${nomeCidade}`;
        porId.set(id, {
          id,
          fonte_chave: id,
          origem: "robo",
          orgao,
          cargo: cargo(ato),
          area: area(`${orgao} ${ato.slice(0, 3000)}`),
          abrangencia: "municipal",
          uf: UF,
          cidade: nomeCidade,
          latitude: mun?.[2] ?? null,
          longitude: mun?.[3] ?? null,
          situacao,
          vagas: vagas(ato),
          banca: banca(ato),
          inscricoes_inicio: insIni,
          inscricoes_fim: insFim,
          prova_data: prova,
          edital_url: pdfUrl,
          fonte_url: `${BASE}/se/prefeitura/${s}/cidadao/diariooficial`,
          observacoes: `Edital ${numEdital} — Diário Oficial do Município de ${nomeCidade}, edição ${ed.numero}.`,
          publicado_em: dataIso,
          verificado_em: new Date().toISOString(),
          visto_em: new Date().toISOString(),
        });
        resumo.novos++;
      }
    }
  }

  // situação pelas datas; tira o que já passou
  const hoje = new Date().toISOString().slice(0, 10);
  const limite = new Date(Date.now() - 45 * 86_400_000).toISOString().slice(0, 10);
  const velho = new Date(Date.now() - 240 * 86_400_000).toISOString().slice(0, 10);
  const itens = [...porId.values()]
    .map((i) => {
      if (!i.id.startsWith("mo:")) return i;
      let st = "edital_publicado";
      if (i.prova_data && i.prova_data < hoje) st = "encerrado";
      else if (i.inscricoes_inicio && hoje < i.inscricoes_inicio) st = "edital_publicado";
      else if (i.inscricoes_fim && hoje > i.inscricoes_fim) st = "andamento";
      else if (i.inscricoes_inicio || i.inscricoes_fim) st = "aberto";
      return { ...i, situacao: st };
    })
    .filter((i) => !i.id.startsWith("mo:") || !(i.prova_data && i.prova_data < limite))
    .filter((i) => !i.id.startsWith("mo:") || !(!i.prova_data && String(i.publicado_em) < velho));

  await writeFile(
    ARQUIVO,
    JSON.stringify({ ...base, gerado_em: new Date().toISOString(), total: itens.length, itens }, null, 1) + "\n",
  );
  console.log(
    `Município Online (SE): cidades ${resumo.cidades}/${CIDADES.length}; edições lidas ${resumo.edicoes}; editais ${resumo.editais}; novos ${resumo.novos}; erros ${resumo.erros}; total no arquivo ${itens.length}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
