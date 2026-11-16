// Coletor do Diário Oficial do Estado de São Paulo (doe.sp.gov.br).
//
// Usa a busca pública do próprio Diário Oficial (sem robots.txt restritivo).
// O DOE-SP publica atos do Estado e de muitos municípios paulistas.
// Só entram EDITAIS DE ABERTURA DE CONCURSO PÚBLICO: convocações, resultados,
// homologações, retificações, processos seletivos e licitações ficam de fora.
//
// Uso: node coletor/sp.mjs  (Node 20+, sem dependências). Lê e atualiza concursos.json.

import { readFile, writeFile } from "node:fs/promises";
import { ABERTURA, DESCARTA, area, banca, cargo, dataProva, norm, periodoInscricoes, textoLimpo, vagas } from "./regras.mjs";

const ARQUIVO = new URL("../concursos.json", import.meta.url);
const UA = "LumenPlanRadar/1.0 (+https://github.com/WSkywalker/lumen-radar-dados)";
const API = "https://do-api-web-search.doe.sp.gov.br/v2";
const MUNICIPIOS_URL = "https://study-zen-planner-53.lovable.app/municipios.json";
const DIAS = Number(process.env.SP_DIAS ?? 3);
const BUSCAS = ["abertura de inscrições", "concurso público", "edital de abertura"];
const MAX_PAGINAS = 10;
const MAX_LEITURAS = 250;
const PAUSA_MS = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoDia = (d) => d.toISOString().slice(0, 10);

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

// título/resumo que indica outra coisa que não a abertura do concurso
const NAO_ABERTURA =
  /(convoca|resultado|homolog|classifica|retifica|prorroga|nomea|posse|gabarito|recurso|deferi|indeferi|aprovad|licitac|pregao|contrato|extrato|processo seletivo|selecao simplificada|credenciamento|chamamento|estagi|residencia|aditamento|cancelamento|anulacao|suspensao|reabertura de prazo)/;

function candidato(it) {
  const titulo = norm(it.title);
  const resumo = norm(it.excerpt);
  if (NAO_ABERTURA.test(titulo)) return false;
  const pareceAbertura =
    /^abertura\b|edital de abertura|abertura de inscric|^concurso\b/.test(titulo) ||
    /(torna publica a abertura|abertura de inscric|abertura do concurso|estarao abertas as inscric|ficam abertas as inscric)/.test(resumo);
  return pareceAbertura && /concurso publico|concurso n/.test(`${titulo} ${resumo}`) && !/processo seletivo/.test(resumo.slice(0, 300));
}

let MUNIS = [];

/** Órgão e cidade a partir da hierarquia ("Municípios > Guarulhos > ..." ou "Executivo > ... > Órgão"). */
function origem(it, conteudo) {
  const niveis = String(it.hierarchy ?? "").split(">").map((s) => s.trim()).filter(Boolean);
  const municipal = /^munic/i.test(niveis[0] ?? "") || String(it.slug ?? "").startsWith("municipios/");
  if (municipal) {
    const nome = niveis[1] ?? "";
    const m = MUNIS.find((x) => x[1] === "SP" && norm(x[0]) === norm(nome));
    const cidade = m ? m[0] : nome || null;
    const orgao = niveis[2] && !/prefeitura/i.test(niveis[2]) ? `${niveis[2]} — ${cidade}` : `Prefeitura de ${cidade}`;
    return { orgao, cidade, lat: m?.[2] ?? null, lon: m?.[3] ?? null, abrangencia: "municipal" };
  }
  // do nível mais fundo para cima, pula unidades internas genéricas (Diretoria de Pessoal, Secretaria Geral...)
  const GENERICO = /^(diretoria|departamento|divisao|coordenadoria|secretaria geral|secretaria executiva|gabinete|secao|servico|nucleo|centro de recursos humanos|unidade|comissao|atos de gestao|despesas|executivo|legislativo|judiciario)\b/;
  const RAMO = /^(executivo|legislativo|judiciario|ministerio publico|atos de gestao e despesas)$/;
  let orgao = "Governo do Estado de São Paulo";
  for (let k = niveis.length - 1; k >= 0; k--) {
    const nk = norm(niveis[k]);
    if (RAMO.test(nk)) {
      if (nk === "ministerio publico") orgao = "Ministério Público do Estado de São Paulo";
      continue;
    }
    if (!GENERICO.test(nk)) {
      orgao = niveis[k];
      break;
    }
  }
  if (/ministerio publico/.test(norm(niveis.join(" "))) && !/ministerio publico/.test(norm(orgao))) orgao = "Ministério Público do Estado de São Paulo";
  if (/^(policia (militar|civil|penal|tecnico-cientifica)|corpo de bombeiros|defensoria publica|tribunal de justica)$/.test(norm(orgao))) orgao = `${orgao} do Estado de São Paulo`;
  // concursos de autarquias ligadas a um município (ex.: Hospital de Ribeirão Preto) continuam estaduais
  void conteudo;
  return { orgao, cidade: null, lat: null, lon: null, abrangencia: "estadual" };
}

async function main() {
  const base = JSON.parse(await readFile(ARQUIVO, "utf8"));
  const porId = new Map(base.itens.map((i) => [i.id, i]));
  try {
    const r = await fetch(MUNICIPIOS_URL, { headers: { "User-Agent": UA } });
    if (r.ok) MUNIS = await r.json();
  } catch {
    MUNIS = [];
  }

  const fim = new Date();
  const ini = new Date(Date.now() - DIAS * 86_400_000);
  const candidatos = new Map();
  for (const termo of BUSCAS) {
    for (let pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
      const q = new URLSearchParams({
        periodStartingDate: isoDia(fim),
        PageNumber: String(pagina),
        "Terms[0]": termo,
        FromDate: isoDia(ini),
        ToDate: isoDia(fim),
        PageSize: "100",
        SortField: "Date",
      });
      const j = await json(`${API}/advanced-search/publications?${q}`);
      await sleep(PAUSA_MS);
      if (!j?.items?.length) break;
      for (const it of j.items) if (candidato(it)) candidatos.set(it.id, it);
      if (!j.hasNextPage) break;
    }
  }

  let lidos = 0, novos = 0;
  for (const [pk, it] of candidatos) {
    const id = `sp:${pk}`;
    if (porId.has(id) && porId.get(id).hierarquia) {
      porId.get(id).visto_em = new Date().toISOString();
      continue;
    }
    if (lidos >= MAX_LEITURAS) break;
    lidos++;
    const d = await json(`${API}/publications/${it.slug}`);
    await sleep(PAUSA_MS);
    const texto = textoLimpo(d?.content ?? "").slice(0, 150000);
    if (!texto) continue;
    const inicio = norm(texto.slice(0, 4000));
    // confirmação no texto completo: é abertura de concurso público
    if (!ABERTURA.test(inicio) || !/concurso publico/.test(inicio)) continue;
    if (DESCARTA.test(norm(texto.slice(0, 600))) && !/concurso publico/.test(norm(texto.slice(0, 600)))) continue;
    if (/processo seletivo/.test(norm(texto.slice(0, 800))) && !/concurso publico/.test(norm(texto.slice(0, 400)))) continue;

    const [insIni, insFim] = periodoInscricoes(texto);
    const prova = dataProva(texto);
    const o = origem(it, texto);
    const h = isoDia(new Date());
    let situacao = "edital_publicado";
    if (prova && prova < h) situacao = "encerrado";
    else if (insIni && h < insIni) situacao = "edital_publicado";
    else if (insFim && h > insFim) situacao = "andamento";
    else if (insIni || insFim) situacao = "aberto";

    porId.set(id, {
      id,
      fonte_chave: id,
      origem: "robo",
      orgao: o.orgao,
      cargo: cargo(texto),
      area: area(`${o.orgao} ${texto.slice(0, 3000)}`),
      abrangencia: o.abrangencia,
      uf: "SP",
      cidade: o.cidade,
      latitude: o.lat,
      longitude: o.lon,
      situacao,
      vagas: vagas(texto.slice(0, 20000)),
      banca: banca(texto),
      inscricoes_inicio: insIni,
      inscricoes_fim: insFim,
      prova_data: prova,
      hierarquia: String(it.hierarchy ?? ""),
      edital_url: `https://doe.sp.gov.br/${it.slug}`,
      fonte_url: `https://doe.sp.gov.br/${it.slug}`,
      observacoes: `${String(it.title ?? "").trim()} — Diário Oficial do Estado de São Paulo de ${String(it.date ?? "").slice(0, 10).split("-").reverse().join("/")}.`,
      publicado_em: String(it.date ?? "").slice(0, 10) || h,
      verificado_em: new Date().toISOString(),
      visto_em: new Date().toISOString(),
    });
    novos++;
  }

  // atualiza situação pelas datas e retira o que já passou
  const h = isoDia(new Date());
  const limite = isoDia(new Date(Date.now() - 45 * 86_400_000));
  const velho = isoDia(new Date(Date.now() - 240 * 86_400_000));
  const itens = [...porId.values()]
    .map((i) => {
      if (!i.id.startsWith("sp:")) return i;
      let s = "edital_publicado";
      if (i.prova_data && i.prova_data < h) s = "encerrado";
      else if (i.inscricoes_inicio && h < i.inscricoes_inicio) s = "edital_publicado";
      else if (i.inscricoes_fim && h > i.inscricoes_fim) s = "andamento";
      else if (i.inscricoes_inicio || i.inscricoes_fim) s = "aberto";
      return { ...i, situacao: s };
    })
    .filter((i) => !i.id.startsWith("sp:") || !(i.prova_data && i.prova_data < limite))
    .filter((i) => !i.id.startsWith("sp:") || !(!i.prova_data && i.publicado_em < velho));

  await writeFile(
    ARQUIVO,
    JSON.stringify({ ...base, gerado_em: new Date().toISOString(), total: itens.length, itens }, null, 1) + "\n",
  );
  console.log(`DOE-SP: candidatos ${candidatos.size}; lidos ${lidos}; novos ${novos}; total no arquivo ${itens.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
